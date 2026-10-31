import { defineConfig } from 'vite';

// Three pages: the landing page (/), the game (/play) and the rating (/rating).
// In development the services (npm run dev:services) answer behind the same
// paths as in production: the API (login, account, rating page), the meta
// server (rooms, ranked queue) and the game server (matches).
const api = 'http://127.0.0.1:8090';
const meta = 'http://127.0.0.1:8091';
const game = 'http://127.0.0.1:8092';

export default defineConfig({
  appType: 'mpa',
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': api,
      '/auth': api,
      '/callback': api,
      '^/rating/?$': api,
      '/meta': { target: meta, ws: true },
      '/game': { target: game, ws: true },
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
