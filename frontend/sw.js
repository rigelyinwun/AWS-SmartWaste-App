/* SmartWaste service worker — Web Push.
   Receives pushes even when the site/tab is closed and shows an OS notification. */

self.addEventListener('push', function(event) {
    var data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { title: 'SmartWaste', body: event.data ? event.data.text() : '' };
    }
    var title = data.title || 'SmartWaste';
    var options = {
        body: data.body || '',
        icon: '/images/logo.png',
        badge: '/images/logo.png',
        data: { url: data.url || '/' },
        tag: data.tag || undefined,
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    var target = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
            // Focus an existing tab if one is open; otherwise open a new one.
            for (var i = 0; i < list.length; i++) {
                var c = list[i];
                if ('focus' in c) {
                    c.navigate && c.navigate(target);
                    return c.focus();
                }
            }
            if (clients.openWindow) return clients.openWindow(target);
        })
    );
});
