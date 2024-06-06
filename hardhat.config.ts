import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import "@openzeppelin/hardhat-upgrades";
import { HardhatUserConfig } from "hardhat/config";

require("dotenv").config();

const emptyPk = "0000000000000000000000000000000000000000000000000000000000000000";

const config: HardhatUserConfig = {
  solidity: "0.8.22",
  typechain: {
    outDir: "typechain",
    target: "ethers-v6",
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      url: "https://sepolia.base.org",
      accounts: [`0x${process.env.TESTNET_OWNER_PK || emptyPk}`],
      verify: {
        etherscan: {
          apiUrl: `${process.env.SEPOLIA_SCAN_API_URL}`,
          apiKey: `${process.env.SEPOLIA_SCAN_API_KEY}`,
        },
      },
    },
    base: {
      url: "https://mainnet.base.org",
      accounts: [`0x${process.env.TESTNET_OWNER_PK || emptyPk}`],
      verify: {
        etherscan: {
          apiUrl: "https://api.basescan.org/api",
          apiKey: `${process.env.BASE_SCAN_API_KEY}`,
        },
      },
    },
  },
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
  etherscan: {
    apiKey: `${process.env.BASE_SCAN_API_KEY}`,
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
};

export default config;
