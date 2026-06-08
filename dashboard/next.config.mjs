/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  distDir: process.env.PISIGNAGE_NEXT_DIST_DIR ?? ".next",
  output: process.env.BEAM_NEXT_OUTPUT
};

export default nextConfig;
