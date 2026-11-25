/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Allow a per-deployment build dir so a second instance (e.g. a white-label
  // TRIJYA FORGE) can run from the same repo on another port without clashing
  // with the default .next of the primary instance.
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // Skip type-checking AND linting during `next build`.
  //
  // WHY: on Render's free tier the build OOMs (JS heap > 2 GB) specifically
  // during the "Linting and checking validity of types" phase — webpack
  // compiles fine, then `tsc` blows the heap and the build dies before
  // writing .next/BUILD_ID, leaving a broken deploy.
  //
  // This is SAFE because types and lint are verified locally (and should be
  // in CI) via `tsc --noEmit` / `next lint` before every push — we don't
  // need to re-run them inside the memory-constrained production build.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },

  // pdf-parse (used to read NAS PDFs) is a CommonJS lib that must run at
  // runtime, not be bundled/transpiled by webpack. @react-pdf/renderer (the
  // proposal PDF download) is loaded at runtime too: it is ESM with its own
  // font and layout engines that webpack does not need to touch.
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse', '@react-pdf/renderer'],
  },
}

export default nextConfig
