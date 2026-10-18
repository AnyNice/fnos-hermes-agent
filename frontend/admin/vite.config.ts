import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ base: './', plugins: [vue()], build: { outDir: '../../app/admin-ui', emptyOutDir: true } });
