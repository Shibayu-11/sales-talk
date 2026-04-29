import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Hiragino Sans"', '"Hiragino Kaku Gothic ProN"', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Per PRD §12.3
        overlay: {
          bg: 'rgba(20, 20, 25, 0.92)',
          text: '#E8E8EC',
          objection: '#FF6B6B',
          success: '#51CF66',
          warning: '#FCC419',
        },
      },
      backdropBlur: {
        overlay: '20px',
      },
    },
  },
  plugins: [],
};

export default config;
