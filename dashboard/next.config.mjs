/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  distDir: process.env.PISIGNAGE_NEXT_DIST_DIR ?? ".next"
};

export default nextConfig;
