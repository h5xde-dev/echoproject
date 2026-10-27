import { defineConfig } from 'vite';

// Three pages: the landing page (/), the game (/play) and the rating (/rating).
// In development the game server (npm run dev:server) answers the API, the
// Yandex login and the ranked WebSocket.
const gameServer = 'http://127.0.0.1:8095';

export default defineConfig({
  appType: 'mpa',
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': gameServer,
      '/auth': gameServer,
      '/callback': gameServer,
      '/ws': { target: gameServer, ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: 'index.html',
        play: 'play.html',
        rating: 'rating.html',
      },
    },
  },
});
