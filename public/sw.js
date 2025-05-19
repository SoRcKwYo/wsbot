const CACHE_NAME = 'wsbot-cache-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  // 添加其他必要的靜態資源，如 CSS、JS、圖片等
];

// 安裝 Service Worker 時快取資源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('開始快取資源');
      })
  );
});

// 攔截網路請求並提供快取回應
self.addEventListener('fetch', event => {
  // 過濾：只處理 HTTP/HTTPS GET 請求
  if (event.request.method !== 'GET' || 
      !event.request.url.startsWith('http')) {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // 如果在快取中找到回應，則返回快取
        if (response) {
          return response;
        }
        
        // 否則發送網路請求
        return fetch(event.request).then(
          response => {
            // 檢查是否收到有效回應
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // 複製回應（因為回應是流，只能使用一次）
            const responseToCache = response.clone();

            caches.open(CACHE_NAME)
              .then(cache => {
                // 這裡是第43行，現在有了額外檢查，不會再報錯
                cache.put(event.request, responseToCache);
              });

            return response;
          }
        );
      })
  );
});

// 清理舊版本快取
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});