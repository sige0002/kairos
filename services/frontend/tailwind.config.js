/** @type {import('tailwindcss').Config} */
// Design tokens from the "Neutral Teal" handoff (60-30-10). The grayscale,
// teal and status hues already match Tailwind's default palette 1:1
// (e.g. teal-600 #0d9488, gray-50 #f9fafb), so only the fonts, shapes,
// shadows and the REC pulse are added here.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Semantic colors resolve through CSS variables in index.css. Components
      // use their role, never a light/dark palette utility, so each token has
      // exactly one light and one dark value.
      colors: {
        app: 'rgb(var(--color-app) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
          muted: 'rgb(var(--color-surface-muted) / <alpha-value>)',
          elevated: 'rgb(var(--color-surface-elevated) / <alpha-value>)',
          control: 'rgb(var(--color-surface-control) / <alpha-value>)',
        },
        text: {
          primary: 'rgb(var(--color-text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-text-secondary) / <alpha-value>)',
          muted: 'rgb(var(--color-text-muted) / <alpha-value>)',
          disabled: 'rgb(var(--color-text-disabled) / <alpha-value>)',
          inverse: 'rgb(var(--color-text-inverse) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--color-border-default) / <alpha-value>)',
          strong: 'rgb(var(--color-border-strong) / <alpha-value>)',
          disabled: 'rgb(var(--color-border-disabled) / <alpha-value>)',
        },
        interaction: {
          hover: 'rgb(var(--color-interaction-hover) / <alpha-value>)',
          selected: 'rgb(var(--color-interaction-selected) / <alpha-value>)',
          disabled: 'rgb(var(--color-interaction-disabled) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          strong: 'rgb(var(--color-accent-strong) / <alpha-value>)',
          soft: 'rgb(var(--color-accent-soft) / <alpha-value>)',
        },
        focus: 'rgb(var(--color-focus) / <alpha-value>)',
        scrim: 'rgb(var(--color-scrim) / var(--opacity-scrim))',
        status: {
          success: {
            bg: 'rgb(var(--color-status-success-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-success-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-success-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-success-accent) / <alpha-value>)',
            contrast: 'rgb(var(--color-status-success-contrast) / <alpha-value>)',
          },
          warning: {
            bg: 'rgb(var(--color-status-warning-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-warning-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-warning-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-warning-accent) / <alpha-value>)',
            contrast: 'rgb(var(--color-status-warning-contrast) / <alpha-value>)',
          },
          danger: {
            bg: 'rgb(var(--color-status-danger-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-danger-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-danger-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-danger-accent) / <alpha-value>)',
            contrast: 'rgb(var(--color-status-danger-contrast) / <alpha-value>)',
          },
          info: {
            bg: 'rgb(var(--color-status-info-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-info-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-info-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-info-accent) / <alpha-value>)',
          },
          live: {
            bg: 'rgb(var(--color-status-live-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-live-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-live-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-live-accent) / <alpha-value>)',
          },
          recording: {
            bg: 'rgb(var(--color-status-recording-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-recording-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-recording-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-recording-accent) / <alpha-value>)',
          },
          paused: {
            bg: 'rgb(var(--color-status-paused-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-paused-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-paused-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-paused-accent) / <alpha-value>)',
          },
          adopted: {
            bg: 'rgb(var(--color-status-adopted-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-adopted-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-adopted-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-adopted-accent) / <alpha-value>)',
          },
          needsreview: {
            bg: 'rgb(var(--color-status-needsreview-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-needsreview-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-needsreview-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-needsreview-accent) / <alpha-value>)',
          },
          excluded: {
            bg: 'rgb(var(--color-status-excluded-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-excluded-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-excluded-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-excluded-accent) / <alpha-value>)',
          },
          suspect: {
            bg: 'rgb(var(--color-status-suspect-bg) / <alpha-value>)',
            border: 'rgb(var(--color-status-suspect-border) / <alpha-value>)',
            text: 'rgb(var(--color-status-suspect-text) / <alpha-value>)',
            accent: 'rgb(var(--color-status-suspect-accent) / <alpha-value>)',
          },
        },
      },
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
        card: '0 1px 2px rgb(var(--color-shadow) / .04)',
        float: '0 10px 30px rgb(var(--color-shadow) / .12)',
        btn: '0 7px 18px rgb(var(--color-accent) / .28)',
        'btn-red': '0 8px 20px rgb(var(--color-status-danger-accent) / .28)',
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
