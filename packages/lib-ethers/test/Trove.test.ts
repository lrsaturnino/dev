// library imports
import { expect } from "chai";
import { BigNumber } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import { Signer } from "@ethersproject/abstract-signer";
import { ethers, deployLiquity } from "hardhat";

// monorepo imports
import {
  Decimal,
  Trove,
  MINIMUM_BORROWING_RATE,
  THUSD_MINIMUM_DEBT,
  THUSD_MINIMUM_NET_DEBT
} from "@threshold-usd/lib-base";

// project imports
import erc20Abi from "../abi/ERC20Test.json";
import { EthersLiquity } from "../src/EthersLiquity";
import * as th from "../utils/testHelpers";
import { _LiquityDeploymentJSON } from "../src/contracts";
import { oracleAddresses } from "../hardhat.config";

const STARTING_BALANCE = Decimal.from(100); // amount of tokens and ETH to initialise

describe("EthersLiquity - Trove", () => {
  let deployer: Signer;
  let funder: Signer;
  let user: Signer;
  let deployment: _LiquityDeploymentJSON;
  let liquity: EthersLiquity;
  let erc20: Contract;
  let userAddress: string;

  // params for borrower operations.
  const withSomeBorrowing = { depositCollateral: 50, borrowTHUSD: THUSD_MINIMUM_NET_DEBT.add(100) };
  const repaySomeDebt = { repayTHUSD: 10 };
  const borrowSomeMore = { borrowTHUSD: 20 };
  const depositMoreCollateral = { depositCollateral: 1 };
  const repayAndWithdraw = { repayTHUSD: 60, withdrawCollateral: 0.5 };
  const borrowAndDeposit = { borrowTHUSD: 60, depositCollateral: 0.5 };

  // Always setup same initial conditions for the user wallets
  beforeEach(async () => {
    // get wallets
    [deployer, funder, user] = await ethers.getSigners();

    // deploy the smart contracts
    deployment = await deployLiquity(deployer, oracleAddresses, "tbtc");

    // create account / connection to liquity for the user wallet
    liquity = await th.connectToDeployment(deployment, user);

    const erc20Address = liquity.connection.addresses.erc20;
    erc20 = new ethers.Contract(erc20Address, erc20Abi, deployer);
    userAddress = await user.getAddress();

    // send user ETH for transactions
    await th.sendAccountETH(user, funder);

    // mint tokens for the user
    const startingTokens = BigNumber.from(STARTING_BALANCE.hex);
    await erc20.mint(userAddress, startingTokens);

    const tokenBalance = await erc20.balanceOf(userAddress);
    expect(`${tokenBalance}`).to.equal(`${BigNumber.from(STARTING_BALANCE.hex)}`);
  });

  it("should have no Trove initially", async () => {
    const trove = await liquity.getTrove();
    expect(trove.isEmpty).to.be.true;
  });

  it("should fail to create an undercollateralized Trove", async () => {
    const price = await liquity.getPrice();
    const undercollateralized = new Trove(THUSD_MINIMUM_DEBT.div(price), THUSD_MINIMUM_DEBT);
    await expect(liquity.openTrove(Trove.recreate(undercollateralized))).to.eventually.be.rejected;
  });

  it("should fail to create a Trove with too little debt", async () => {
    const withTooLittleDebt = new Trove(Decimal.from(50), THUSD_MINIMUM_DEBT.sub(1));
    await expect(liquity.openTrove(Trove.recreate(withTooLittleDebt))).to.eventually.be.rejected;
  });

  it("should create a Trove with some borrowing", async () => {
    const { newTrove, fee } = await liquity.openTrove(withSomeBorrowing);
    expect(newTrove).to.deep.equal(Trove.create(withSomeBorrowing));
    expect(`${fee}`).to.equal(`${MINIMUM_BORROWING_RATE.mul(withSomeBorrowing.borrowTHUSD)}`);
  });

  it("should fail to withdraw all the collateral while the Trove has debt", async () => {
    // setup
    await liquity.openTrove(withSomeBorrowing);

    // check debt > 0
    const trove = await liquity.getTrove();
    expect(trove.debt.gt(0)).to.be.true;

    // try to withdraw
    await expect(liquity.withdrawCollateral(trove.collateral)).to.eventually.be.rejected;
  });

  it("should repay some debt", async () => {
    // setup
    await liquity.openTrove(withSomeBorrowing);

    // test
    const { newTrove, fee } = await liquity.repayTHUSD(repaySomeDebt.repayTHUSD);
    expect(newTrove).to.deep.equal(Trove.create(withSomeBorrowing).adjust(repaySomeDebt));
    expect(`${fee}`).to.equal("0");
  });

  it("should borrow some more", async () => {
    // setup
    await liquity.openTrove(withSomeBorrowing);
    await liquity.repayTHUSD(repaySomeDebt.repayTHUSD);

    // test
    const { newTrove, fee } = await liquity.borrowTHUSD(borrowSomeMore.borrowTHUSD);
    expect(newTrove).to.deep.equal(
      Trove.create(withSomeBorrowing)
        .adjust(repaySomeDebt)
        .adjust(borrowSomeMore)
    );
    expect(`${fee}`).to.equal(`${MINIMUM_BORROWING_RATE.mul(borrowSomeMore.borrowTHUSD)}`);
  });

  it("should deposit more collateral", async () => {
    // setup
    await liquity.openTrove(withSomeBorrowing);
    await liquity.repayTHUSD(repaySomeDebt.repayTHUSD);
    await liquity.borrowTHUSD(borrowSomeMore.borrowTHUSD);

    // test
    const { newTrove } = await liquity.depositCollateral(depositMoreCollateral.depositCollateral);
    expect(newTrove).to.deep.equal(
      Trove.create(withSomeBorrowing)
        .adjust(repaySomeDebt)
        .adjust(borrowSomeMore)
        .adjust(depositMoreCollateral)
    );
  });

  it("should repay some debt and withdraw some collateral at the same time", async () => {
    // setup
    await liquity.openTrove(withSomeBorrowing);

    // test
    const {
      rawReceipt,
      details: { newTrove }
    } = await th.waitForSuccess(liquity.send.adjustTrove(repayAndWithdraw));

    expect(newTrove).to.deep.equal(
      Trove.create(withSomeBorrowing)
        .adjust(repayAndWithdraw)
    );

    // check the user has the extra collateral
    const userBalance = await erc20.balanceOf(userAddress);
    const expectedBalance = BigNumber.from(STARTING_BALANCE
      .sub(withSomeBorrowing.depositCollateral)
      .add(repayAndWithdraw.withdrawCollateral).hex);

    expect(`${userBalance}`).to.equal(`${expectedBalance}`);
  });

  it("should borrow more and deposit some collateral at the same time", async () => {
    // setup
    await liquity.openTrove(withSomeBorrowing);

    // test
    const {
      rawReceipt,
      details: { newTrove, fee }
    } = await th.waitForSuccess(liquity.send.adjustTrove(borrowAndDeposit));

    expect(newTrove).to.deep.equal(
      Trove.create(withSomeBorrowing)
        .adjust(borrowAndDeposit)
    );

    // check fee
    expect(`${fee}`).to.equal(`${MINIMUM_BORROWING_RATE.mul(borrowAndDeposit.borrowTHUSD)}`);

    // check user balance
    const userBalance = await erc20.balanceOf(userAddress);
    const expectedBalance = BigNumber.from(STARTING_BALANCE
      .sub(withSomeBorrowing.depositCollateral)
      .sub(borrowAndDeposit.depositCollateral).hex);

    expect(`${userBalance}`).to.equal(`${expectedBalance}`);
  });

  it("should close the Trove with some thUSD from another user", async () => {
    // setup
    const { newTrove, fee } = await liquity.openTrove(withSomeBorrowing);
    const thusdBalance = await liquity.getTHUSDBalance();
    const thusdShortage = newTrove.netDebt.sub(thusdBalance); // there is a shortage due to fees

    // initialise the funder with tokens
    const startingTokens = BigNumber.from(STARTING_BALANCE.hex);
    await erc20.mint(await funder.getAddress(), startingTokens);

    // create seperate connection to lib-ethers for the funder and open a trove
    const funderLiquity = await th.connectToDeployment(deployment, funder);
    const price = await liquity.getPrice();
    let funderTrove = Trove.create({ depositCollateral: 1, borrowTHUSD: thusdShortage });
    funderTrove = funderTrove.setDebt(Decimal.max(funderTrove.debt, THUSD_MINIMUM_DEBT));
    funderTrove = funderTrove.setCollateral(funderTrove.debt.mulDiv(1.51, price));
    await funderLiquity.openTrove(Trove.recreate(funderTrove));

    // send the shortfall to the user
    await funderLiquity.sendTHUSD(userAddress, thusdShortage);

    // user closes their trove
    const { params } = await liquity.closeTrove();
    expect(params).to.deep.equal({
      withdrawCollateral: newTrove.collateral,
      repayTHUSD: newTrove.netDebt
    });

    // get the users trove and check its empty
    const finalTrove = await liquity.getTrove();
    expect(finalTrove.isEmpty).to.be.true;
  });
});
