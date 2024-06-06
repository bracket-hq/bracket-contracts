import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { BG_Beta, USBG } from "../typechain";

const FEES = { pool: 100n, collective: 600n, protocol: 300n };

type FullPrice = {
  base: bigint;
  protocolFee: bigint;
  collectiveFee: bigint;
  poolFee: bigint;
  totalFee: bigint;
  total: bigint;
  perVote: bigint;
};

// Returns the price following the curve equation
function getPrice(supply: bigint, amount: bigint) {
  const firstTerm = ((supply + 1n) * 10n ** 6n) / 100n;
  const lastTerm = ((supply + amount) * 10n ** 6n) / 100n;

  return (amount * (firstTerm + lastTerm)) / 2n;
}

const getFullPrice = (isBuy: boolean, base: bigint, perVote: bigint): FullPrice => {
  const poolFee = (base * FEES.pool) / 10000n;
  const collectiveFee = (base * FEES.collective) / 10000n;
  const protocolFee = (base * FEES.protocol) / 10000n;
  const totalFee = poolFee + collectiveFee + protocolFee;
  const total = isBuy ? base + totalFee : base - totalFee;

  return {
    base,
    protocolFee,
    collectiveFee,
    poolFee,
    totalFee,
    total,
    perVote,
  };
};

describe("BracketGame Test Suite", () => {
  let bgBeta: BG_Beta;
  let usbg: USBG;
  let owner: SignerWithAddress;
  let nonOwner: SignerWithAddress;
  let collective: SignerWithAddress;
  let protDest: SignerWithAddress;
  let oracle: SignerWithAddress;
  let claimer: SignerWithAddress;
  let manager: SignerWithAddress;

  const currentSeason = 1n;
  const roundsN = 3n;
  const winningBreakdown = [0n, 100n, 250n, 650n];

  async function getFeesBalances(collective: string) {
    return {
      pool: await bgBeta.prizePool(),
      collective: await usbg.balanceOf(collective),
      protocol: await usbg.balanceOf(protDest.address),
    };
  }

  async function initializeCollective(account: SignerWithAddress) {
    await usbg.airdrop(account.address, 1000);
    await usbg.connect(account).approve(bgBeta.target, 1000000000);
    // Buy the first vote
    await bgBeta.connect(account).buyVotes(account.address, 1, 0);
  }

  beforeEach(async () => {
    [owner, nonOwner, collective, protDest, oracle, claimer, manager] = await ethers.getSigners();

    const USBG = await ethers.getContractFactory("USBG");
    usbg = (await USBG.deploy("US Bracket Game", "USBG")) as unknown as USBG;
    await usbg.waitForDeployment();

    const BG_BetaFactory = await ethers.getContractFactory("BG_Beta", owner);
    bgBeta = (await upgrades.deployProxy(BG_BetaFactory, [100, usbg.target], {
      initializer: "initialize",
    })) as unknown as BG_Beta;
    await bgBeta.waitForDeployment();
    await bgBeta.setTxPause(false);

    // Send airdrops and approve BG_Beta contract to spend USBG
    const airdrops = [nonOwner, claimer];
    for (const account of airdrops) {
      await usbg.airdrop(account.address, 1000000000000);
      await usbg.connect(account).approve(bgBeta.target, 100000000000000);
    }

    await bgBeta.connect(owner).setFeeStructure(FEES.pool, FEES.collective, FEES.protocol, protDest.address);
    await bgBeta.connect(owner).setSeason(currentSeason, roundsN, winningBreakdown);

    await initializeCollective(collective);

    // Grant roles
    const roles = {
      [oracle.address]: ethers.id("ORACLE_ROLE"),
      [claimer.address]: ethers.id("CLAIMER_ROLE"),
      [manager.address]: ethers.id("MANAGER_ROLE"),
    };
    for (const [account, role] of Object.entries(roles)) {
      await expect(bgBeta.connect(owner).grantRole(role, account))
        .to.emit(bgBeta, "RoleGranted")
        .withArgs(role, account, owner.address);
    }
  });

  describe("setFeeStructure", () => {
    it("should allow the owner to set the fee structure", async () => {
      await expect(bgBeta.connect(owner).setFeeStructure(100, 600, 300, protDest.address)).to.not.be.reverted;
    });

    it("should not allow a non-owner to set the fee structure", async () => {
      await expect(bgBeta.connect(nonOwner).setFeeStructure(100, 600, 300, protDest.address)).to.be.reverted;
    });

    it("should not allow to set fees more than 100% in total", async () => {
      await expect(bgBeta.connect(nonOwner).setFeeStructure(1000, 6000, 3000, protDest.address)).to.be.reverted;
    });
  });

  describe("setTxPause", () => {
    it("should allow the owner to pause and unpause transactions", async () => {
      await expect(bgBeta.connect(owner).setTxPause(true)).to.not.be.reverted;
      await expect(bgBeta.connect(owner).setTxPause(false)).to.not.be.reverted;
    });

    it("should not allow a non-owner to pause or unpause transactions", async () => {
      await expect(bgBeta.connect(nonOwner).setTxPause(true)).to.be.reverted;
      await expect(bgBeta.connect(nonOwner).setTxPause(false)).to.be.reverted;
    });
  });

  describe("setSeason", () => {
    it("should allow the owner to set an season", async () => {
      // Get a fresh contract with uninitialized season
      const BG_BetaFactory = await ethers.getContractFactory("BG_Beta", owner);
      bgBeta = (await upgrades.deployProxy(BG_BetaFactory, [100, usbg.target], {
        initializer: "initialize",
      })) as unknown as BG_Beta;
      await bgBeta.waitForDeployment();

      await expect(bgBeta.connect(owner).setSeason(currentSeason, roundsN, winningBreakdown)).to.not.be.reverted;

      const block = (await ethers.provider.getBlock("latest"))?.number;
      expect(await bgBeta.seasonNow()).to.be.deep.equal(
        Object.values({
          isDistributed: false,
          isVerified: false,
          startBlock: block,
          endBlock: 0,
          prizePool: 0,
          distributedPool: 0,
          roundsN: roundsN,
          winningBreakdown,
        }),
      );
    });

    it("should not allow a non-owner to set a season", async () => {
      await expect(bgBeta.connect(nonOwner).setSeason(currentSeason, roundsN, winningBreakdown)).to.be.reverted;
    });

    it("should revert when setting a new season before the current one is distributed", async () => {
      await expect(bgBeta.connect(owner).setSeason(currentSeason + 1n, roundsN, winningBreakdown)).to.be.reverted;
    });

    it("should revert when setting a 0 season", async () => {
      // Get a fresh contract with uninitialized season
      const BG_BetaFactory = await ethers.getContractFactory("BG_Beta", owner);
      bgBeta = (await upgrades.deployProxy(BG_BetaFactory, [100, usbg.target], {
        initializer: "initialize",
      })) as unknown as BG_Beta;
      await bgBeta.waitForDeployment();

      await expect(bgBeta.connect(owner).setSeason(0n, roundsN, winningBreakdown)).to.be.reverted;
    });

    it("should revert when setting a previous season", async () => {
      await expect(bgBeta.connect(owner).setSeason(currentSeason - 1n, roundsN, winningBreakdown)).to.be.reverted;
    });

    it("should allow setting a new season after the current one is distributed", async () => {
      const prizePool = await bgBeta.prizePool();
      const prevBlock = (await bgBeta.seasonNow()).startBlock;

      // Distribute the current season, 100% to the collective
      await bgBeta.setSeason(currentSeason, 2, [0, 0, 10000]);
      await bgBeta.connect(oracle).receiveVerifiedCollectiveExitRound(collective.address, 2);
      await bgBeta.connect(oracle).receiveVerifiedTotalWinnings(true);
      await bgBeta.connect(manager).distributeSeasonWinnings([collective.address]);
      expect((await bgBeta.seasonNow()).isDistributed).to.be.true;

      const endBlock = (await ethers.provider.getBlock("latest"))?.number;

      await expect(bgBeta.connect(owner).setSeason(currentSeason + 1n, roundsN, winningBreakdown)).not.to.be.reverted;
      expect(await bgBeta.seasons(currentSeason)).to.be.deep.equal(
        Object.values({
          isDistributed: true,
          isVerified: true,
          startBlock: prevBlock,
          endBlock,
          prizePool,
          distributedPool: prizePool,
          roundsN: 2,
        }),
      );

      const block = (await ethers.provider.getBlock("latest"))?.number;
      expect(await bgBeta.seasonNow()).to.be.deep.equal(
        Object.values({
          isDistributed: false,
          isVerified: false,
          startBlock: block,
          endBlock: 0,
          // Prize pool goes back to 0
          prizePool: 0,
          distributedPool: 0,
          roundsN: roundsN,
          winningBreakdown: winningBreakdown,
        }),
      );
    });

    it("should allow to update the current season before it's distributed", async () => {
      const newRoundsN = 5n;
      const newWinningBreakdown = [0n, 100n, 250n, 650n, 700n, 800n];

      const season = await bgBeta.seasonNow();
      const prizePool = await bgBeta.prizePool();
      await expect(bgBeta.connect(owner).setSeason(currentSeason, newRoundsN, newWinningBreakdown)).not.to.be.reverted;

      expect(await bgBeta.seasonNow()).to.be.deep.equal(
        Object.values({
          isDistributed: false,
          isVerified: false,
          startBlock: season.startBlock,
          endBlock: 0,
          prizePool,
          distributedPool: 0,
          roundsN: newRoundsN,
          winningBreakdown: newWinningBreakdown,
        }),
      );
    });
  });

  describe("distributeSeasonWinnings", () => {
    it("should allow the owner to distribute season winnings", async () => {
      const collectives = [collective.address];

      await bgBeta.connect(oracle).receiveVerifiedTotalWinnings(true);
      await expect(bgBeta.connect(manager).distributeSeasonWinnings(collectives)).to.not.be.reverted;
    });

    it("should not allow a non-owner to distribute season winnings", async () => {
      const collectives = [collective.address];
      await expect(bgBeta.connect(nonOwner).distributeSeasonWinnings(collectives)).to.be.reverted;
    });
  });

  describe("Oracle", () => {
    describe("receiveVerifiedCollectiveExitRound", () => {
      it("should allow oracle to set the round of a specific collective", async () => {
        await expect(bgBeta.connect(oracle).receiveVerifiedCollectiveExitRound(collective.address, 2)).to.not.be
          .reverted;
      });

      it("should not allow non-oracle to set the round of a specific collective", async () => {
        await expect(bgBeta.connect(nonOwner).receiveVerifiedCollectiveExitRound(collective.address, 2)).to.be.reverted;
      });
    });

    describe("receiveVerifiedTotalWinnings", () => {
      it("should allow oracle to verify total winnings", async () => {
        await expect(bgBeta.connect(oracle).receiveVerifiedTotalWinnings(true)).to.not.be.reverted;
      });

      it("should not allow non-oracle to verify total winnings", async () => {
        await expect(bgBeta.connect(nonOwner).receiveVerifiedTotalWinnings(true)).to.be.reverted;
      });
    });
  });

  describe("collectives", () => {
    it("should return correct initial collective name, supply, burnt shares", async () => {
      expect(await bgBeta.collectives(collective.address)).to.be.deep.equal(["", 1n, 0n]);
    });

    it("should return empty name, supply, burnt shares for a non-collective", async () => {
      expect(await bgBeta.collectives(nonOwner.address)).to.be.deep.equal(["", 0n, 0n]);
    });
  });

  describe("getBuyPrice", () => {
    it("should return correct price breakdown based on the curve", async () => {
      const amount = 100n;
      const expectedPrice = await bgBeta.getBuyPrice(collective.address, amount);

      const [, supply] = await bgBeta.collectives(collective.address);
      expect(supply).to.eq(1n);
      const basePrice = getPrice(supply, amount);

      // Base price matches the curve
      expect(expectedPrice.base).to.eq(basePrice);

      // Fees match
      const protocolFee = (basePrice * FEES.protocol) / 10000n;
      expect(expectedPrice.protocolFee).to.be.eq(protocolFee);
      const collectiveFee = (basePrice * FEES.collective) / 10000n;
      expect(expectedPrice.collectiveFee).to.be.eq(collectiveFee);
      const poolFee = (basePrice * FEES.pool) / 10000n;
      expect(expectedPrice.poolFee).to.be.eq(poolFee);

      // Contract breakdown matches
      const fullPrice = getFullPrice(true, expectedPrice.base, getPrice(supply, 1n));
      expect(expectedPrice).to.be.deep.eq(Object.values(fullPrice));
    });

    it("should return 0 for 0 amount", async () => {
      expect(await bgBeta.getBuyPrice(collective.address, 0)).to.be.deep.eq(
        Object.values(getFullPrice(true, 0n, getPrice(1n, 1n))),
      );
    });

    it("should ignore the state of burnt shares for calculation", async () => {
      const amount = 100n;
      const toBurn = 50n;
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, amount, 0)).to.not.be.reverted;
      const price = await bgBeta.getBuyPrice(collective.address, amount);
      await expect(bgBeta.connect(nonOwner).redeemVotes(collective.address, toBurn)).to.not.be.reverted;
      expect(await bgBeta.getBuyPrice(collective.address, amount)).to.be.deep.eq(price);
    });
  });

  describe("getSellPrice", () => {
    it("should return correct price breakdown based on the curve", async () => {
      const amount = 100n;
      // Buy enough to have enough to sell
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, amount * 2n, 0)).to.not.be.reverted;
      const expectedPrice = await bgBeta.getSellPrice(collective.address, amount);

      const [, supply] = await bgBeta.collectives(collective.address);
      const basePrice = getPrice(supply - amount, amount);

      // Base price matches the curve
      expect(expectedPrice.base).to.eq(basePrice);

      // Fees match
      const protocolFee = (basePrice * FEES.protocol) / 10000n;
      expect(expectedPrice.protocolFee).to.be.eq(protocolFee);
      const collectiveFee = (basePrice * FEES.collective) / 10000n;
      expect(expectedPrice.collectiveFee).to.be.eq(collectiveFee);
      const poolFee = (basePrice * FEES.pool) / 10000n;
      expect(expectedPrice.poolFee).to.be.eq(poolFee);

      // Contract breakdown matches
      const fullPrice = getFullPrice(false, expectedPrice.base, getPrice(supply, 1n));
      expect(expectedPrice).to.be.deep.eq(Object.values(fullPrice));
    });

    it("should return 0 for 0 amount", async () => {
      expect(await bgBeta.getSellPrice(collective.address, 0)).to.be.deep.eq(
        Object.values(getFullPrice(false, 0n, getPrice(1n, 1n))),
      );
    });

    it("should ignore the state of burnt shares for calculation", async () => {
      const amount = 100n;
      const toBurn = 50n;
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, amount, 0)).to.not.be.reverted;
      const price = await bgBeta.getSellPrice(collective.address, amount);
      await expect(bgBeta.connect(nonOwner).redeemVotes(collective.address, toBurn)).to.not.be.reverted;
      expect(await bgBeta.getSellPrice(collective.address, amount)).to.be.deep.eq(price);
    });

    it("should return 0 when estimating the price for more shares than supply", async () => {
      expect(await bgBeta.getSellPrice(collective.address, 10000)).to.be.deep.eq(
        Object.values(getFullPrice(false, 0n, getPrice(1n, 1n))),
      );
    });
  });

  describe("getRedeemPrice", () => {
    it("should return 0 when collective treasury is 0", async () => {
      // Empty the treasury
      await usbg.connect(collective).transfer(owner.address, await usbg.balanceOf(collective.address));
      expect(await usbg.balanceOf(collective.address)).to.be.equal(0);
      expect(await bgBeta.getRedeemPrice(collective.address, 1)).to.be.equal(0);
    });

    it("should return 0 for 0 amount", async () => {
      expect(await usbg.balanceOf(collective.address)).to.be.gt(0);
      expect(await bgBeta.getRedeemPrice(collective.address, 0)).to.be.equal(0);
    });

    it("should return the correct share of the collective's treasury based on voting power", async () => {
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, 99, 0)).to.not.be.reverted;
      expect(await bgBeta.collectives(collective.address)).to.be.deep.equal(["", 100, 0]);

      const balance = await usbg.balanceOf(collective.address);

      const amount = 10n;
      const votingPower = (amount * 1000000n) / (100n - 0n);
      const expectedPrice = (balance * votingPower) / 1000000n;
      expect(await bgBeta.getRedeemPrice(collective.address, amount)).to.be.equal(expectedPrice);
    });

    it("should consider that burnt shares increase the voting power", async () => {
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, 49, 0)).to.not.be.reverted;

      await expect(bgBeta.connect(claimer).buyVotes(collective.address, 50, 0)).to.not.be.reverted;
      await expect(bgBeta.connect(claimer).redeemVotes(collective.address, 50)).to.not.be.reverted;

      const balance = await usbg.balanceOf(collective.address);
      expect(await bgBeta.collectives(collective.address)).to.be.deep.equal(["", 100n, 50n]);

      const amount = 10n;
      const votingPower = (amount * 1000000n) / (100n - 50n);
      const expectedPrice = (balance * votingPower) / 1000000n;
      expect(await bgBeta.getRedeemPrice(collective.address, amount)).to.be.equal(expectedPrice);
    });
  });

  describe("buyVotes", () => {
    it("should not allow users to buy votes of non-initialized collectives", async () => {
      await expect(bgBeta.connect(nonOwner).buyVotes(owner.address, 5, 0)).to.be.reverted;
    });

    it("should allow users to buy votes, using the same price as predicted by getBuyPrice", async () => {
      const amount = 100n;
      const expectedPrice = await bgBeta.getBuyPrice(collective.address, amount);
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, amount, 0))
        .to.emit(bgBeta, "Trade")
        .withArgs(
          nonOwner.address,
          collective.address,
          true,
          amount,
          amount,
          amount + 1n,
          Object.values(getFullPrice(true, expectedPrice.base, getPrice(amount + 1n, 1n))),
        )
        .emit(usbg, "Transfer")
        .withArgs(nonOwner.address, bgBeta.target, expectedPrice.base)
        .emit(usbg, "Transfer")
        .withArgs(nonOwner.address, bgBeta.target, expectedPrice.poolFee)
        .emit(usbg, "Transfer")
        .withArgs(nonOwner.address, protDest.address, expectedPrice.protocolFee)
        .emit(usbg, "Transfer")
        .withArgs(nonOwner.address, collective.address, expectedPrice.collectiveFee);

      expect(await bgBeta.collectives(collective.address)).to.be.deep.equal(["", amount + 1n, 0n]);
      expect(await bgBeta.balanceOf(nonOwner.address, collective.address)).to.be.equal(amount);
    });

    it("should not allow users to buy votes with too low 'slippage'", async () => {
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, 5, 1)).to.be.reverted;
    });

    it("handles fees correctly", async () => {
      const beforeFees = await getFeesBalances(collective.address);

      const expectedPrice = await bgBeta.getBuyPrice(collective.address, 5);
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, 5, 0)).to.emit(bgBeta, "Trade");

      const afterFees = await getFeesBalances(collective.address);
      expect(afterFees.pool).to.be.equal(beforeFees.pool + expectedPrice.poolFee);
      expect(afterFees.collective).to.be.equal(beforeFees.collective + expectedPrice.collectiveFee);
      expect(afterFees.protocol).to.be.equal(beforeFees.protocol + expectedPrice.protocolFee);
    });

    it("should revert when buying during the season winnings distribution", async () => {
      // Add second collective, to make distribution done in 2 transactions
      await initializeCollective(manager);
      await bgBeta.connect(nonOwner).increasePrizePool(50000000);

      await bgBeta.connect(manager).setSeason(currentSeason, 2, [0, 0, 5000]);

      // Simulate the season winnings distribution
      await bgBeta.connect(oracle).receiveVerifiedCollectiveExitRound(collective.address, 2);
      await bgBeta.connect(oracle).receiveVerifiedCollectiveExitRound(manager.address, 2);
      await bgBeta.connect(oracle).receiveVerifiedTotalWinnings(true);

      // Start distribution
      await bgBeta.connect(manager).distributeSeasonWinnings([collective.address]);
      // Attempt to buy votes during the distribution
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, 5, 0)).to.be.reverted;
      // Finish distribution
      await bgBeta.connect(manager).distributeSeasonWinnings([manager.address]);
      expect((await bgBeta.seasons(currentSeason)).isDistributed).to.be.true;

      await bgBeta.setSeason(currentSeason + 1n, 2, [0, 0, 5000]);

      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, 5, 0)).to.not.be.reverted;
    });
  });

  describe("sellVotes", () => {
    const amount = 100n;

    beforeEach(async () => {
      // Buy first, to sell later
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, amount, 0)).to.not.be.reverted;
    });

    it("should allow users to sell votes, using the same price as predicted by getSellPrice", async () => {
      const toSell = amount - 1n;
      const newSupply = amount - toSell + 1n;
      const expectedPrice = await bgBeta.getSellPrice(collective.address, toSell);

      await expect(bgBeta.connect(nonOwner).sellVotes(collective.address, toSell, 0))
        .to.emit(bgBeta, "Trade")
        .withArgs(
          nonOwner.address,
          collective.address,
          false,
          toSell,
          amount - toSell,
          newSupply,
          Object.values(getFullPrice(false, expectedPrice.base, getPrice(newSupply - 1n, 1n))),
        )
        .emit(usbg, "Transfer")
        .withArgs(bgBeta.target, nonOwner.address, expectedPrice.total)
        .emit(usbg, "Transfer")
        .withArgs(bgBeta.target, protDest.address, expectedPrice.protocolFee)
        .emit(usbg, "Transfer")
        .withArgs(bgBeta.target, collective.address, expectedPrice.collectiveFee);

      expect(await bgBeta.collectives(collective.address)).to.be.deep.equal(["", newSupply, 0n]);
      expect(await bgBeta.balanceOf(nonOwner.address, collective.address)).to.be.equal(amount - toSell);
    });

    it("should not allow users to sell more votes than they have purchased", async () => {
      await expect(bgBeta.connect(nonOwner).sellVotes(collective.address, amount * 2n, 0)).to.be.reverted;
    });

    it("should not allow users to sell with high 'slippage'", async () => {
      await expect(bgBeta.connect(nonOwner).sellVotes(collective.address, 1, 10000000)).to.be.reverted;
    });

    it("should allow users to sell the last vote", async () => {
      const balance = await bgBeta.balanceOf(nonOwner.address, collective.address);
      await expect(bgBeta.connect(nonOwner).sellVotes(collective.address, balance, 0)).to.not.be.reverted;
    });

    it("should not allow the collective to sell the last vote", async () => {
      const balance = await bgBeta.balanceOf(collective.address, collective.address);
      await expect(bgBeta.connect(collective).sellVotes(collective.address, balance, 0)).to.be.reverted;
    });

    it("should not allow to sell already redeemed votes", async () => {
      const balance = await bgBeta.balanceOf(nonOwner.address, collective.address);
      await expect(bgBeta.connect(nonOwner).redeemVotes(collective.address, balance - 1n)).to.not.be.reverted;
      await expect(bgBeta.connect(nonOwner).sellVotes(collective.address, balance, 0)).to.be.reverted;
    });

    it("handles fees correctly", async () => {
      const beforeFees = await getFeesBalances(collective.address);

      const expectedPrice = await bgBeta.getSellPrice(collective.address, 5);
      await expect(bgBeta.connect(nonOwner).sellVotes(collective.address, 5, 0)).to.emit(bgBeta, "Trade");

      const afterFees = await getFeesBalances(collective.address);
      expect(afterFees.pool).to.be.equal(beforeFees.pool + expectedPrice.poolFee);
      expect(afterFees.collective).to.be.equal(beforeFees.collective + expectedPrice.collectiveFee);
      expect(afterFees.protocol).to.be.equal(beforeFees.protocol + expectedPrice.protocolFee);
    });
  });

  describe("redeemVotes", () => {
    const amount = 7n;

    beforeEach(async () => {
      // Need to buy votes before they can redeem them
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, amount, 1000000)).to.not.be.reverted;
    });

    it("should allow users to redeem votes", async () => {
      const [, supply, burnt] = await bgBeta.collectives(collective.address);
      const expectedPrice = await bgBeta.getRedeemPrice(collective.address, amount);
      await expect(bgBeta.connect(nonOwner).redeemVotes(collective.address, amount))
        .to.emit(bgBeta, "Redeem")
        .withArgs(nonOwner.address, collective.address, amount, 0, 1n, expectedPrice);

      expect(await bgBeta.balanceOf(nonOwner.address, collective.address)).to.be.equal(0);
      expect(await bgBeta.collectives(collective.address)).to.be.deep.equal(["", supply, burnt + amount]);
    });

    it("should not allow users to redeem more votes than they own", async () => {
      await expect(bgBeta.connect(nonOwner).redeemVotes(collective.address, 8)).to.be.reverted;
    });

    it("should not allow collective to redeem the last vote", async () => {
      await expect(bgBeta.connect(collective).redeemVotes(collective.address, 1)).to.be.reverted;
    });
  });

  describe("transferVotes", () => {
    const amount = 7n;

    beforeEach(async () => {
      // Need to buy votes before they can transfer them
      await expect(bgBeta.connect(nonOwner).buyVotes(collective.address, amount, 1000000)).to.not.be.reverted;
      await expect(bgBeta.connect(claimer).buyVotes(collective.address, amount, 1000000)).to.not.be.reverted;
    });

    it("should revert for account with no CLAIMER_ROLE role", async () => {
      await expect(bgBeta.connect(nonOwner).transferVotes([collective.address], [owner.address], [1])).to.be.reverted;
    });

    it("should allow users to transfer votes up to the qty that they own", async () => {
      expect(await bgBeta.balanceOf(claimer.address, collective.address)).to.be.equal(amount);

      await expect(bgBeta.connect(claimer).transferVotes([collective.address], [owner.address], [amount]))
        .to.emit(bgBeta, "TransferVotes")
        .withArgs(claimer.address, collective.address, owner.address, amount);

      expect(await bgBeta.balanceOf(claimer.address, collective.address)).to.be.equal(0);
      expect(await bgBeta.balanceOf(owner.address, collective.address)).to.be.equal(amount);
    });

    it("should not allow users to transfer votes they don't have", async () => {
      await expect(bgBeta.connect(claimer).transferVotes([collective.address], [owner.address], [amount * 2n])).to.be
        .reverted;
    });

    it("should not allow collective to transfer the last vote", async () => {
      await bgBeta.connect(owner).grantRole(ethers.id("CLAIMER_ROLE"), collective.address);
      await expect(await bgBeta.balanceOf(collective.address, collective.address)).to.be.equal(1);
      await expect(bgBeta.connect(collective).transferVotes([collective.address], [owner.address], [1])).to.be.reverted;
    });
  });

  describe("increasePrizePool", () => {
    it("should increase the prize pool by unprivileged user", async () => {
      const prizePool = await bgBeta.prizePool();
      const balance = await usbg.balanceOf(bgBeta.target);
      const season = await bgBeta.currentSeason();
      await expect(bgBeta.connect(nonOwner).increasePrizePool(1000n))
        .to.emit(bgBeta, "IncreasePrizePool")
        .withArgs(season, 1000n);
      expect(await bgBeta.prizePool()).to.be.equal(prizePool + 1000n);
      expect(await usbg.balanceOf(bgBeta.target)).to.be.equal(balance + 1000n);
    });
  });

  describe("setCollectiveFanbases", () => {
    // TODO
  });
});
