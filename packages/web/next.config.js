/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  serverExternalPackages: ["@composio/core", "@anthropic-ai/sdk", "@aws-sdk/client-bedrock-runtime", "@aws-sdk/credential-providers"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // @composio/core is an optional peer dep of tracker-linear.
      // Webpack tries to resolve the dynamic import() inside the bundled
      // tracker-linear code and fails because the package isn't installed.
      // Mark it as an external so webpack skips resolution entirely.
      config.externals = config.externals || [];
      config.externals.push("@composio/core");
    }
    return config;
  },
};

export default nextConfig;
