import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // If deploying to GitHub Pages uncomment the line below
  // and replace 'your-repo-name' with your actual GitHub repo name:
  base: './',
})
