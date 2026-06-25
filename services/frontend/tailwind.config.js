/** @type {import('tailwindcss').Config} */
// Design tokens from the "Neutral Teal" handoff (60-30-10). The grayscale,
// teal and status hues already match Tailwind's default palette 1:1
// (e.g. teal-600 #0d9488, gray-50 #f9fafb), so only the fonts, shapes,
// shadows and the REC pulse are added here.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Tight"', 'system-ui', 'sans-serif'],
        // Numerics, IDs, topic names and code are monospaced so measurements align.
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        // card 14–16 / control 9–11 / chip 6–8
        card: '15px',
        control: '10px',
        chip: '7px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(17,24,39,.04)',
        float: '0 10px 30px rgba(17,24,39,.12)',
        btn: '0 7px 18px rgba(13,148,136,.28)',
        'btn-red': '0 8px 20px rgba(220,38,38,.28)',
      },
      keyframes: {
        recpulse: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '.4', transform: 'scale(.8)' },
        },
      },
      animation: {
        recpulse: 'recpulse 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
