import { PHASE_PRODUCTION_BUILD } from "next/constants.js";

/** @type {(phase: string) => import('next').NextConfig} */
const nextConfig = (phase) => ({
  devIndicators: false,
  distDir: phase === PHASE_PRODUCTION_BUILD ? ".next-build" : ".next"
});

export default nextConfig;
