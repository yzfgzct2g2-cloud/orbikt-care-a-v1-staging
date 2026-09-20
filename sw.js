/* global self, URL, Response, Headers */
(() => {
  'use strict'

  const CACHE_PREFIX = 'orbikt-care-a-shell-'
  const DATABASE_NAME = 'orbikt-care-a'
  const DATABASE_VERSION = 1
  const MIGRATION_ID = 'schema-v1'
  const MAX_ASSETS = 64
  const BASE_PATH = new URL(self.registration?.scope ?? self.location.origin).pathname.replace(/\/$/, '')
  const projectPath = (path) => `${BASE_PATH}${path}`

  function allowedAsset(path) {
    return path === projectPath('/index.html') ||
      path === projectPath('/manifest.webmanifest') ||
      path === projectPath('/icons/icon-192.png') ||
      path === projectPath('/icons/icon-512.png') ||
      new RegExp(`^${projectPath('/assets/')}[A-Za-z0-9._-]+\\.(?:css|js)$`).test(path)
  }

  function validateMetadata(value) {
    if (!value || typeof value !== 'object' ||
        typeof value.version !== 'string' || !/^[a-f0-9]{6,64}$/.test(value.version) ||
        !Array.isArray(value.assets) || value.assets.length === 0 ||
        value.assets.length > MAX_ASSETS) {
      throw new Error('Invalid shell metadata')
    }

    const assets = value.assets.map((asset) => {
      if (typeof asset !== 'string' || !allowedAsset(asset) ||
          asset.includes('..') || asset.includes('?') || asset.includes('#') ||
          asset.startsWith('//')) {
        throw new Error('Unsafe shell asset')
      }
      const parsed = new URL(asset, self.location.origin)
      if (parsed.origin !== self.location.origin || parsed.pathname !== asset) {
        throw new Error('Cross-origin shell asset')
      }
      return asset
    })

    if (new Set(assets).size !== assets.length || !assets.includes(projectPath('/index.html'))) {
      throw new Error('Incomplete shell metadata')
    }
    return { version: value.version, assets }
  }

  function projectCacheNames(keys) {
    return keys.filter((key) => key.startsWith(CACHE_PREFIX))
  }

  function verifyDatabase() {
    return new Promise((resolve, reject) => {
      const request = self.indexedDB.open(DATABASE_NAME)
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        request.result.close()
        reject(new Error('Application database is not initialized'))
      }
      request.onerror = () => reject(request.error ?? new Error('Database open failed'))
      request.onsuccess = () => {
        const database = request.result
        if (database.version !== DATABASE_VERSION ||
            !database.objectStoreNames.contains('migrationHistory')) {
          database.close()
          reject(new Error('Incompatible application database'))
          return
        }
        const transaction = database.transaction('migrationHistory', 'readonly')
        const markerRequest = transaction.objectStore('migrationHistory').get(DATABASE_VERSION)
        markerRequest.onerror = () => reject(markerRequest.error ?? new Error('Migration marker read failed'))
        markerRequest.onsuccess = () => {
          const marker = markerRequest.result
          database.close()
          if (!marker || marker.id !== MIGRATION_ID || marker.version !== DATABASE_VERSION) {
            reject(new Error('Migration marker mismatch'))
          } else {
            resolve()
          }
        }
      }
    })
  }

  async function loadMetadata() {
    const response = await self.fetch(projectPath('/shell-assets.json'), { cache: 'no-store' })
    if (!response.ok) throw new Error('Shell metadata unavailable')
    return validateMetadata(await response.json())
  }

  async function installShell() {
    await verifyDatabase()
    const metadata = await loadMetadata()
    const cacheName = `${CACHE_PREFIX}${metadata.version}`
    const cache = await self.caches.open(cacheName)
    try {
      await cache.addAll(metadata.assets)
      await cache.put(projectPath('/shell-assets.json'), new Response(JSON.stringify(metadata), {
        headers: { 'content-type': 'application/json' }
      }))
    } catch (cause) {
      await self.caches.delete(cacheName)
      throw cause
    }
  }

  async function activateShell() {
    const names = projectCacheNames(await self.caches.keys())
    const current = names.at(-1)
    await Promise.all(names.filter((name) => name !== current).map((name) => self.caches.delete(name)))
  }

  async function matchProjectCache(request) {
    const cacheKey = typeof request === 'string' ? request : new URL(request.url).pathname
    const names = projectCacheNames(await self.caches.keys()).reverse()
    for (const name of names) {
      const response = await (await self.caches.open(name)).match(cacheKey)
      if (response) {
        const headers = new Headers(response.headers)
        headers.delete('content-encoding')
        headers.delete('content-length')
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        })
      }
    }
    return undefined
  }

  self.addEventListener('install', (event) => event.waitUntil(installShell()))
  self.addEventListener('activate', (event) => event.waitUntil(activateShell()))
  self.addEventListener('fetch', (event) => {
    const request = event.request
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.origin !== self.location.origin) return

    if (request.mode === 'navigate') {
      event.respondWith(self.fetch(request).catch(() => matchProjectCache(projectPath('/index.html'))))
      return
    }
    if (allowedAsset(url.pathname)) {
      event.respondWith(matchProjectCache(request).then((cached) => cached ?? self.fetch(request)))
    }
  })

  Object.defineProperty(self, '__orbiktPwaPolicy', {
    value: Object.freeze({ validateMetadata, projectCacheNames }),
    enumerable: false
  })
})()
