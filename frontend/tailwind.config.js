/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
  safelist: ['bg-gray-950', 'bg-gray-900', 'text-gray-100', 'text-yellow-400'],
};