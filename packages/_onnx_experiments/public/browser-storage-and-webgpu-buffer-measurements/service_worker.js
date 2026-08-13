///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	service_worker — exists only so Chrome offers to install this page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Milestone 2 of issue #169 has to record whether navigator.storage.persist() is granted to an ordinary tab and to the
// same page installed as a Progressive Web Application. The second half of that measurement cannot be taken unless
// Chrome offers to install the page, and Chrome wants a manifest and a service worker with a fetch handler before it
// offers.
//
// This service worker therefore caches nothing at all, on purpose. Every request goes straight to the network. A cache
// here would only make the measurements on this page report the speed of that cache rather than the speed of the
// browser storage they exist to measure.

self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
	event.respondWith(fetch(event.request));
});
