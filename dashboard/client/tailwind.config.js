/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"] ,
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f7ff",
          100: "#e0effe",
          200: "#badcfe",
          300: "#7cc0fd",
          400: "#379ef9",
          500: "#0c81eb",
          600: "#0265ca",
          700: "#0250a3",
          800: "#084586",
          900: "#0d3b6f",
          950: "#09254a",
        },
        ink: {
          50: "#f4f6f8",
          100: "#e8ecef",
          200: "#c6ced6",
          300: "#a3b1bd",
          400: "#708496",
          500: "#4d6376",
          600: "#3d4e5d",
          700: "#33414d",
          800: "#1a232e", // Deep background
          900: "#0f1721", // Darker background
          950: "#080c13", // Blackest
        },
        ocean: {
          500: "#1f6feb",
          400: "#4ea1ff",
          300: "#87c2ff"
        },
        neon: {
          500: "#33f0b5"
        }
      },
      fontFamily: {
        display: ["'Space Grotesk'", "sans-serif"],
        sans: ["'Inter'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"]
      },
      boxShadow: {
        glow: "0 0 20px rgba(31, 111, 235, 0.15)",
        soft: "0 10px 40px rgba(0, 0, 0, 0.4)",
        glass: "inset 0 1px 1px 0 rgba(255, 255, 255, 0.05)"
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
      }
    }
  },
  plugins: []
};