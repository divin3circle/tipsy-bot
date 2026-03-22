import path from "path";
import { fileURLToPath } from "url";
import webpack from "webpack";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  entry: {
    background: "./background.js",
    content: "./content.js",
  },
  output: {
    filename: "[name].bundle.js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
  },
  resolve: {
    extensions: [".js"],
    alias: {
      "sodium-native": path.resolve(
        __dirname,
        "scripts/shims/sodium-native.js",
      ),
      "sodium-universal": path.resolve(
        __dirname,
        "scripts/shims/sodium-native.js",
      ),
      "process/browser": "process/browser.js",
    },
    fallback: {
      crypto: "crypto-browserify",
      stream: "stream-browserify",
      buffer: "buffer",
      path: false,
      fs: false,
      os: false,
      net: false,
      tls: false,
      http: false,
      https: false,
      url: false,
      zlib: false,
      vm: false,
      process: "process/browser",
    },
  },
  module: {
    rules: [],
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ["buffer", "Buffer"],
      process: "process/browser",
    }),
    // Exclude test files and cryptographic key files from bundle
    new webpack.IgnorePlugin({
      resourceRegExp:
        /(test|__tests__|\.test\.|\.spec\.|\.pem|\.key|\.crt|\.cert)$/,
    }),
  ],
  optimization: {
    minimize: false,
  },
};
