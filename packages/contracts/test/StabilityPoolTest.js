const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const th = testHelpers.TestHelper
const dec = th.dec
const toBN = th.toBN
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const TroveManagerTester = artifacts.require("TroveManagerTester")

const ZERO_ADDRESS = th.ZERO_ADDRESS

contract('StabilityPool', async accounts => {

  const [owner,
    defaulter_1, defaulter_2, defaulter_3,
    whale,
    alice, bob, carol, dennis, erin, flyn,
    A, B, C, D, E,
  ] = accounts;

  const contextTestStabilityPool = (isCollateralERC20) => {

    let contracts
    let priceFeed
    let thusdToken
    let sortedTroves
    let troveManager
    let activePool
    let stabilityPool
    let defaultPool
    let borrowerOperations
    let erc20

    const getOpenTroveTHUSDAmount = async (totalDebt) => th.getOpenTroveTHUSDAmount(contracts, totalDebt)
    const openTrove = async (params) => th.openTrove(contracts, params)
    const assertRevert = th.assertRevert
    const getCollateralBalance = async (address) => th.getCollateralBalance(erc20, address)
    const provideToSP = async (amount, params) => th.provideToSP(contracts, amount, params)

    describe("Stability Pool Mechanisms", async () => {

      beforeEach(async () => {
        contracts = await deploymentHelper.deployLiquityCore(accounts)
        contracts.troveManager = await TroveManagerTester.new()
        contracts.thusdToken = (await deploymentHelper.deployTHUSDToken(contracts)).thusdToken
        if (!isCollateralERC20) {
          contracts.erc20.address = ZERO_ADDRESS
        }

        priceFeed = contracts.priceFeedTestnet
        thusdToken = contracts.thusdToken
        sortedTroves = contracts.sortedTroves
        troveManager = contracts.troveManager
        activePool = contracts.activePool
        stabilityPool = contracts.stabilityPool
        defaultPool = contracts.defaultPool
        borrowerOperations = contracts.borrowerOperations
        hintHelpers = contracts.hintHelpers
        erc20 = contracts.erc20

        await deploymentHelper.connectCoreContracts(contracts)

      })

      // --- provideToSP() ---
      // increases recorded THUSD at Stability Pool
      it("provideToSP(): increases the Stability Pool THUSD balance", async () => {
        // --- SETUP --- Give Alice a least 200
        await openTrove({ extraTHUSDAmount: toBN(200), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

        // --- TEST ---

        // provideToSP()
        await provideToSP(200, { from: alice })

        // check THUSD balances after
        const stabilityPool_THUSD_After = await stabilityPool.getTotalTHUSDDeposits()
        assert.equal(stabilityPool_THUSD_After, 200)
      })

      it("provideToSP(): updates the user's deposit record in StabilityPool", async () => {
        // --- SETUP --- Give Alice a least 200
        await openTrove({ extraTHUSDAmount: toBN(200), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

        // --- TEST ---
        // check user's deposit record before
        const alice_depositRecord_Before = await stabilityPool.deposits(alice)
        assert.equal(alice_depositRecord_Before, 0)

        // provideToSP()
        await provideToSP(200, { from: alice })

        // check user's deposit record after
        const alice_depositRecord_After = (await stabilityPool.deposits(alice))
        assert.equal(alice_depositRecord_After, 200)
      })

      it("provideToSP(): reduces the user's THUSD balance by the correct amount", async () => {
        // --- SETUP --- Give Alice a least 200
        await openTrove({ extraTHUSDAmount: toBN(200), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

        // --- TEST ---
        // get user's deposit record before
        const alice_THUSDBalance_Before = await thusdToken.balanceOf(alice)

        // provideToSP()
        await provideToSP(200, { from: alice })

        // check user's THUSD balance change
        const alice_THUSDBalance_After = await thusdToken.balanceOf(alice)
        assert.equal(alice_THUSDBalance_Before.sub(alice_THUSDBalance_After), '200')
      })

      it("provideToSP(): increases totalTHUSDDeposits by correct amount", async () => {
        // --- SETUP ---

        // Whale opens Trove with 50 ETH/tokens, adds 2000 THUSD to StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(2000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
        await provideToSP(dec(2000, 18), { from: whale })

        const totalTHUSDDeposits = await stabilityPool.getTotalTHUSDDeposits()
        assert.equal(totalTHUSDDeposits, dec(2000, 18))
      })

      it('provideToSP(): Correctly updates user snapshots of accumulated rewards per unit staked', async () => {
        // --- SETUP ---

        // Whale opens Trove and deposits to SP
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
        const whaleTHUSD = await thusdToken.balanceOf(whale)
        await provideToSP(whaleTHUSD, { from: whale })

        // 2 Troves opened, each withdraws minimum debt
        await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1, } })
        await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2, } })

        // Alice makes Trove and withdraws 100 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(100, 18)), ICR: toBN(dec(5, 18)), extraParams: { from: alice } })


        // price drops: defaulter's Troves fall below MCR, whale doesn't
        await priceFeed.setPrice(dec(105, 18));

        const SPTHUSD_Before = await stabilityPool.getTotalTHUSDDeposits()

        // Troves are closed
        await troveManager.liquidate(defaulter_1, { from: owner })
        await troveManager.liquidate(defaulter_2, { from: owner })
        assert.isFalse(await sortedTroves.contains(defaulter_1))
        assert.isFalse(await sortedTroves.contains(defaulter_2))

        // Confirm SP has decreased
        const SPTHUSD_After = await stabilityPool.getTotalTHUSDDeposits()
        assert.isTrue(SPTHUSD_After.lt(SPTHUSD_Before))

        // --- TEST ---
        const P_Before = (await stabilityPool.P())
        const S_Before = (await stabilityPool.epochToScaleToSum(0, 0))
        assert.isTrue(P_Before.gt(toBN('0')))
        assert.isTrue(S_Before.gt(toBN('0')))

        // Check 'Before' snapshots
        const alice_snapshot_Before = await stabilityPool.depositSnapshots(alice)
        const alice_snapshot_S_Before = alice_snapshot_Before[0].toString()
        const alice_snapshot_P_Before = alice_snapshot_Before[1].toString()
        assert.equal(alice_snapshot_S_Before, '0')
        assert.equal(alice_snapshot_P_Before, '0')

        // Make deposit
        await provideToSP(dec(100, 18), { from: alice })

        // Check 'After' snapshots
        const alice_snapshot_After = await stabilityPool.depositSnapshots(alice)
        const alice_snapshot_S_After = alice_snapshot_After[0].toString()
        const alice_snapshot_P_After = alice_snapshot_After[1].toString()

        assert.equal(alice_snapshot_S_After, S_Before)
        assert.equal(alice_snapshot_P_After, P_Before)
      })

      it("provideToSP(), multiple deposits: updates user's deposit and snapshots", async () => {
        // --- SETUP ---
        // Whale opens Trove and deposits to SP
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
        const whaleTHUSD = await thusdToken.balanceOf(whale)
        await provideToSP(whaleTHUSD, { from: whale })

        // 3 Troves opened. Two users withdraw 160 THUSD each
        await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })
        await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_3 } })

        // --- TEST ---

        // Alice makes deposit #1: 150 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(250, 18)), ICR: toBN(dec(3, 18)), extraParams: { from: alice } })
        await provideToSP(dec(150, 18), { from: alice })

        const alice_Snapshot_0 = await stabilityPool.depositSnapshots(alice)
        const alice_Snapshot_S_0 = alice_Snapshot_0[0]
        const alice_Snapshot_P_0 = alice_Snapshot_0[1]
        assert.equal(alice_Snapshot_S_0, 0)
        assert.equal(alice_Snapshot_P_0, '1000000000000000000')

        // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
        await priceFeed.setPrice(dec(105, 18));

        // 2 users with Trove with 180 THUSD drawn are closed
        await troveManager.liquidate(defaulter_1, { from: owner })  // 180 THUSD closed
        await troveManager.liquidate(defaulter_2, { from: owner }) // 180 THUSD closed

        const alice_compoundedDeposit_1 = await stabilityPool.getCompoundedTHUSDDeposit(alice)

        // Alice makes deposit #2
        const alice_topUp_1 = toBN(dec(100, 18))
        await provideToSP(alice_topUp_1, { from: alice })

        const alice_newDeposit_1 = (await stabilityPool.deposits(alice)).toString()
        assert.equal(alice_compoundedDeposit_1.add(alice_topUp_1), alice_newDeposit_1)

        // get system reward terms
        const P_1 = await stabilityPool.P()
        const S_1 = await stabilityPool.epochToScaleToSum(0, 0)
        assert.isTrue(P_1.lt(toBN(dec(1, 18))))
        assert.isTrue(S_1.gt(toBN('0')))

        // check Alice's new snapshot is correct
        const alice_Snapshot_1 = await stabilityPool.depositSnapshots(alice)
        const alice_Snapshot_S_1 = alice_Snapshot_1[0]
        const alice_Snapshot_P_1 = alice_Snapshot_1[1]
        assert.isTrue(alice_Snapshot_S_1.eq(S_1))
        assert.isTrue(alice_Snapshot_P_1.eq(P_1))

        // Bob withdraws THUSD and deposits to StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await provideToSP(dec(427, 18), { from: alice })

        // Defaulter 3 Trove is closed
        await troveManager.liquidate(defaulter_3, { from: owner })

        const alice_compoundedDeposit_2 = await stabilityPool.getCompoundedTHUSDDeposit(alice)

        const P_2 = await stabilityPool.P()
        const S_2 = await stabilityPool.epochToScaleToSum(0, 0)
        assert.isTrue(P_2.lt(P_1))
        assert.isTrue(S_2.gt(S_1))

        // Alice makes deposit #3:  100THUSD
        await provideToSP(dec(100, 18), { from: alice })

        // check Alice's new snapshot is correct
        const alice_Snapshot_2 = await stabilityPool.depositSnapshots(alice)
        const alice_Snapshot_S_2 = alice_Snapshot_2[0]
        const alice_Snapshot_P_2 = alice_Snapshot_2[1]
        assert.isTrue(alice_Snapshot_S_2.eq(S_2))
        assert.isTrue(alice_Snapshot_P_2.eq(P_2))
      })

      it("provideToSP(): reverts if user tries to provide more than their THUSD balance", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        const aliceTHUSDbal = await thusdToken.balanceOf(alice)
        const bobTHUSDbal = await thusdToken.balanceOf(bob)

        // Alice, attempts to deposit 1 wei more than her balance

        const aliceTxPromise = provideToSP(aliceTHUSDbal.add(toBN(1)), { from: alice })
        await assertRevert(aliceTxPromise, "revert")

        // Bob, attempts to deposit 235534 more than his balance

        const bobTxPromise = provideToSP(bobTHUSDbal.add(toBN(dec(235534, 18))), { from: bob })
        await assertRevert(bobTxPromise, "revert")
      })

      it("provideToSP(): reverts if user tries to provide 2^256-1 THUSD, which exceeds their balance", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

        const maxBytes32 = web3.utils.toBN("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")

        // Alice attempts to deposit 2^256-1 THUSD
        try {
          aliceTx = await provideToSP(maxBytes32, { from: alice })
          assert.isFalse(tx.receipt.status)
        } catch (error) {
          assert.include(error.message, "revert")
        }
      })

      // TODO decide if we need this EIP-165
      // it("provideToSP(): reverts if cannot receive ETH Gain", async () => {
      //   // --- SETUP ---
      //   // Whale deposits 1850 THUSD in StabilityPool
      //   await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
      //   await provideToSP(dec(1850, 18), { from: whale })
      //
      //   // Defaulter Troves opened
      //   await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
      //   await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })
      //
      //   // --- TEST ---
      //
      //   const nonPayable = await NonPayable.new()
      //   await thusdToken.transfer(nonPayable.address, dec(250, 18), { from: whale })
      //
      //   // NonPayable makes deposit #1: 150 THUSD
      //   const txData1 = th.getTransactionData('provideToSP(uint256)', [web3.utils.toHex(dec(150, 18))])
      //   const tx1 = await nonPayable.forward(stabilityPool.address, txData1)
      //
      //   const gain_0 = await stabilityPool.getDepositorCollateralGain(nonPayable.address)
      //   assert.isTrue(gain_0.eq(toBN(0)), 'NonPayable should not have accumulated gains')
      //
      //   // price drops: defaulters' Troves fall below MCR, nonPayable and whale Trove remain active
      //   await priceFeed.setPrice(dec(105, 18));
      //
      //   // 2 defaulters are closed
      //   await troveManager.liquidate(defaulter_1, { from: owner })
      //   await troveManager.liquidate(defaulter_2, { from: owner })
      //
      //   const gain_1 = await stabilityPool.getDepositorCollateralGain(nonPayable.address)
      //   assert.isTrue(gain_1.gt(toBN(0)), 'NonPayable should have some accumulated gains')
      //
      //   // NonPayable tries to make deposit #2: 100THUSD (which also attempts to withdraw ETH gain)
      //   const txData2 = th.getTransactionData('provideToSP(uint256)', [web3.utils.toHex(dec(100, 18))])
      //   await th.assertRevert(nonPayable.forward(stabilityPool.address, txData2), 'StabilityPool: sending ETH failed')
      // })

      it("provideToSP(): doesn't impact other users' deposits or collateral gains", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(1000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(2000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        await provideToSP(dec(1000, 18), { from: alice })
        await provideToSP(dec(2000, 18), { from: bob })
        await provideToSP(dec(3000, 18), { from: carol })

        // D opens a trove
        await openTrove({ extraTHUSDAmount: toBN(dec(300, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

        // Would-be defaulters open troves
        await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })

        // Price drops
        await priceFeed.setPrice(dec(105, 18))

        // Defaulters are liquidated
        await troveManager.liquidate(defaulter_1)
        await troveManager.liquidate(defaulter_2)
        assert.isFalse(await sortedTroves.contains(defaulter_1))
        assert.isFalse(await sortedTroves.contains(defaulter_2))

        const alice_THUSDDeposit_Before = (await stabilityPool.getCompoundedTHUSDDeposit(alice)).toString()
        const bob_THUSDDeposit_Before = (await stabilityPool.getCompoundedTHUSDDeposit(bob)).toString()
        const carol_THUSDDeposit_Before = (await stabilityPool.getCompoundedTHUSDDeposit(carol)).toString()

        const alice_CollateralGain_Before = (await stabilityPool.getDepositorCollateralGain(alice)).toString()
        const bob_CollateralGain_Before = (await stabilityPool.getDepositorCollateralGain(bob)).toString()
        const carol_CollateralGain_Before = (await stabilityPool.getDepositorCollateralGain(carol)).toString()

        //check non-zero THUSD and CollateralGain in the Stability Pool
        const THUSDinSP = await stabilityPool.getTotalTHUSDDeposits()
        const collateralInSP = await stabilityPool.getCollateralBalance()
        assert.isTrue(THUSDinSP.gt(mv._zeroBN))
        assert.isTrue(collateralInSP.gt(mv._zeroBN))

        // D makes an SP deposit
        await provideToSP(dec(1000, 18), { from: dennis })
        assert.equal((await stabilityPool.getCompoundedTHUSDDeposit(dennis)).toString(), dec(1000, 18))

        const alice_THUSDDeposit_After = (await stabilityPool.getCompoundedTHUSDDeposit(alice)).toString()
        const bob_THUSDDeposit_After = (await stabilityPool.getCompoundedTHUSDDeposit(bob)).toString()
        const carol_THUSDDeposit_After = (await stabilityPool.getCompoundedTHUSDDeposit(carol)).toString()

        const alice_CollateralGain_After = (await stabilityPool.getDepositorCollateralGain(alice)).toString()
        const bob_CollateralGain_After = (await stabilityPool.getDepositorCollateralGain(bob)).toString()
        const carol_CollateralGain_After = (await stabilityPool.getDepositorCollateralGain(carol)).toString()

        // Check compounded deposits and collateral gains for A, B and C have not changed
        assert.equal(alice_THUSDDeposit_Before, alice_THUSDDeposit_After)
        assert.equal(bob_THUSDDeposit_Before, bob_THUSDDeposit_After)
        assert.equal(carol_THUSDDeposit_Before, carol_THUSDDeposit_After)

        assert.equal(alice_CollateralGain_Before, alice_CollateralGain_After)
        assert.equal(bob_CollateralGain_Before, bob_CollateralGain_After)
        assert.equal(carol_CollateralGain_Before, carol_CollateralGain_After)
      })

      it("provideToSP(): doesn't impact system debt, collateral or TCR", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(1000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(2000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        await provideToSP(dec(1000, 18), { from: alice })
        await provideToSP(dec(2000, 18), { from: bob })
        await provideToSP(dec(3000, 18), { from: carol })

        // D opens a trove
        await openTrove({ extraTHUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

        // Would-be defaulters open troves
        await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ extraTHUSDAmount: 0, ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })

        // Price drops
        await priceFeed.setPrice(dec(105, 18))

        // Defaulters are liquidated
        await troveManager.liquidate(defaulter_1)
        await troveManager.liquidate(defaulter_2)
        assert.isFalse(await sortedTroves.contains(defaulter_1))
        assert.isFalse(await sortedTroves.contains(defaulter_2))

        const activeDebt_Before = (await activePool.getTHUSDDebt()).toString()
        const defaultedDebt_Before = (await defaultPool.getTHUSDDebt()).toString()
        const activeColl_Before = (await activePool.getCollateralBalance()).toString()
        const defaultedColl_Before = (await defaultPool.getCollateralBalance()).toString()
        const TCR_Before = (await th.getTCR(contracts)).toString()

        // D makes an SP deposit
        await provideToSP(dec(1000, 18), { from: dennis })
        assert.equal((await stabilityPool.getCompoundedTHUSDDeposit(dennis)).toString(), dec(1000, 18))

        const activeDebt_After = (await activePool.getTHUSDDebt()).toString()
        const defaultedDebt_After = (await defaultPool.getTHUSDDebt()).toString()
        const activeColl_After = (await activePool.getCollateralBalance()).toString()
        const defaultedColl_After = (await defaultPool.getCollateralBalance()).toString()
        const TCR_After = (await th.getTCR(contracts)).toString()

        // Check total system debt, collateral and TCR have not changed after a Stability deposit is made
        assert.equal(activeDebt_Before, activeDebt_After)
        assert.equal(defaultedDebt_Before, defaultedDebt_After)
        assert.equal(activeColl_Before, activeColl_After)
        assert.equal(defaultedColl_Before, defaultedColl_After)
        assert.equal(TCR_Before, TCR_After)
      })

      it("provideToSP(): doesn't impact any troves, including the caller's trove", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(1000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(2000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        // A and B provide to SP
        await provideToSP(dec(1000, 18), { from: alice })
        await provideToSP(dec(2000, 18), { from: bob })

        // D opens a trove
        await openTrove({ extraTHUSDAmount: toBN(dec(1000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

        // Price drops
        await priceFeed.setPrice(dec(105, 18))
        const price = await priceFeed.getPrice()

        // Get debt, collateral and ICR of all existing troves
        const whale_Debt_Before = (await troveManager.Troves(whale))[0].toString()
        const alice_Debt_Before = (await troveManager.Troves(alice))[0].toString()
        const bob_Debt_Before = (await troveManager.Troves(bob))[0].toString()
        const carol_Debt_Before = (await troveManager.Troves(carol))[0].toString()
        const dennis_Debt_Before = (await troveManager.Troves(dennis))[0].toString()

        const whale_Coll_Before = (await troveManager.Troves(whale))[1].toString()
        const alice_Coll_Before = (await troveManager.Troves(alice))[1].toString()
        const bob_Coll_Before = (await troveManager.Troves(bob))[1].toString()
        const carol_Coll_Before = (await troveManager.Troves(carol))[1].toString()
        const dennis_Coll_Before = (await troveManager.Troves(dennis))[1].toString()

        const whale_ICR_Before = (await troveManager.getCurrentICR(whale, price)).toString()
        const alice_ICR_Before = (await troveManager.getCurrentICR(alice, price)).toString()
        const bob_ICR_Before = (await troveManager.getCurrentICR(bob, price)).toString()
        const carol_ICR_Before = (await troveManager.getCurrentICR(carol, price)).toString()
        const dennis_ICR_Before = (await troveManager.getCurrentICR(dennis, price)).toString()

        // D makes an SP deposit
        await provideToSP(dec(1000, 18), { from: dennis })
        assert.equal((await stabilityPool.getCompoundedTHUSDDeposit(dennis)).toString(), dec(1000, 18))

        const whale_Debt_After = (await troveManager.Troves(whale))[0].toString()
        const alice_Debt_After = (await troveManager.Troves(alice))[0].toString()
        const bob_Debt_After = (await troveManager.Troves(bob))[0].toString()
        const carol_Debt_After = (await troveManager.Troves(carol))[0].toString()
        const dennis_Debt_After = (await troveManager.Troves(dennis))[0].toString()

        const whale_Coll_After = (await troveManager.Troves(whale))[1].toString()
        const alice_Coll_After = (await troveManager.Troves(alice))[1].toString()
        const bob_Coll_After = (await troveManager.Troves(bob))[1].toString()
        const carol_Coll_After = (await troveManager.Troves(carol))[1].toString()
        const dennis_Coll_After = (await troveManager.Troves(dennis))[1].toString()

        const whale_ICR_After = (await troveManager.getCurrentICR(whale, price)).toString()
        const alice_ICR_After = (await troveManager.getCurrentICR(alice, price)).toString()
        const bob_ICR_After = (await troveManager.getCurrentICR(bob, price)).toString()
        const carol_ICR_After = (await troveManager.getCurrentICR(carol, price)).toString()
        const dennis_ICR_After = (await troveManager.getCurrentICR(dennis, price)).toString()

        assert.equal(whale_Debt_Before, whale_Debt_After)
        assert.equal(alice_Debt_Before, alice_Debt_After)
        assert.equal(bob_Debt_Before, bob_Debt_After)
        assert.equal(carol_Debt_Before, carol_Debt_After)
        assert.equal(dennis_Debt_Before, dennis_Debt_After)

        assert.equal(whale_Coll_Before, whale_Coll_After)
        assert.equal(alice_Coll_Before, alice_Coll_After)
        assert.equal(bob_Coll_Before, bob_Coll_After)
        assert.equal(carol_Coll_Before, carol_Coll_After)
        assert.equal(dennis_Coll_Before, dennis_Coll_After)

        assert.equal(whale_ICR_Before, whale_ICR_After)
        assert.equal(alice_ICR_Before, alice_ICR_After)
        assert.equal(bob_ICR_Before, bob_ICR_After)
        assert.equal(carol_ICR_Before, carol_ICR_After)
        assert.equal(dennis_ICR_Before, dennis_ICR_After)
      })

      it("provideToSP(): doesn't protect the depositor's trove from liquidation", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(1000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(2000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        // A, B provide 100 THUSD to SP
        await provideToSP(dec(1000, 18), { from: alice })
        await provideToSP(dec(1000, 18), { from: bob })

        // Confirm Bob has an active trove in the system
        assert.isTrue(await sortedTroves.contains(bob))
        assert.equal((await troveManager.getTroveStatus(bob)).toString(), '1')  // Confirm Bob's trove status is active

        // Confirm Bob has a Stability deposit
        assert.equal((await stabilityPool.getCompoundedTHUSDDeposit(bob)).toString(), dec(1000, 18))

        // Price drops
        await priceFeed.setPrice(dec(105, 18))
        const price = await priceFeed.getPrice()

        // Liquidate bob
        await troveManager.liquidate(bob)

        // Check Bob's trove has been removed from the system
        assert.isFalse(await sortedTroves.contains(bob))
        assert.equal((await troveManager.getTroveStatus(bob)).toString(), '3')  // check Bob's trove status was closed by liquidation
      })

      it("provideToSP(): providing 0 THUSD reverts", async () => {
        // --- SETUP ---
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(1000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(2000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        // A, B, C provides 100, 50, 30 THUSD to SP
        await provideToSP(dec(100, 18), { from: alice })
        await provideToSP(dec(50, 18), { from: bob })
        await provideToSP(dec(30, 18), { from: carol })

        const bob_Deposit_Before = (await stabilityPool.getCompoundedTHUSDDeposit(bob)).toString()
        const THUSDinSP_Before = (await stabilityPool.getTotalTHUSDDeposits()).toString()

        assert.equal(THUSDinSP_Before, dec(180, 18))

        // Bob provides 0 THUSD to the Stability Pool
        const txPromise_B = provideToSP(0, { from: bob })
        await th.assertRevert(txPromise_B)
      })

      // --- PCV functionality ---
      it("provideToSP(), new deposit: depositor does not receive collateral gains", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // Whale transfers THUSD to A, B
        await thusdToken.transfer(A, dec(100, 18), { from: whale })
        await thusdToken.transfer(B, dec(200, 18), { from: whale })

        // C, D open troves
        await openTrove({ extraTHUSDAmount: toBN(dec(1000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
        await openTrove({ extraTHUSDAmount: toBN(dec(2000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

        // --- TEST ---

        // get current collateral balances
        const A_CollateralBalance_Before = await getCollateralBalance(A)
        const B_CollateralBalance_Before = await getCollateralBalance(B)
        const C_CollateralBalance_Before = await getCollateralBalance(C)
        const D_CollateralBalance_Before = await getCollateralBalance(D)

        // A, B, C, D provide to SP
        await provideToSP(dec(100, 18), { from: A, gasPrice: 0 })
        await provideToSP(dec(200, 18), { from: B, gasPrice: 0 })
        await provideToSP(dec(300, 18), { from: C, gasPrice: 0 })
        await provideToSP(dec(400, 18), { from: D, gasPrice: 0 })

        // Get  collateral balances after
        const A_CollateralBalance_After = await getCollateralBalance(A)
        const B_CollateralBalance_After = await getCollateralBalance(B)
        const C_CollateralBalance_After = await getCollateralBalance(C)
        const D_CollateralBalance_After = await getCollateralBalance(D)

        // Check collateral balances have not changed
        assert.isTrue(A_CollateralBalance_After.eq(A_CollateralBalance_Before))
        assert.isTrue(B_CollateralBalance_After.eq(B_CollateralBalance_Before))
        assert.isTrue(C_CollateralBalance_After.eq(C_CollateralBalance_Before))
        assert.isTrue(D_CollateralBalance_After.eq(D_CollateralBalance_Before))
      })

      it("provideToSP(), new deposit after past full withdrawal: depositor does not receive collateral gains", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // Whale transfers THUSD to A, B
        await thusdToken.transfer(A, dec(1000, 18), { from: whale })
        await thusdToken.transfer(B, dec(1000, 18), { from: whale })

        // C, D open troves
        await openTrove({ extraTHUSDAmount: toBN(dec(4000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
        await openTrove({ extraTHUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // --- SETUP ---
        // A, B, C, D provide to SP
        await provideToSP(dec(105, 18), { from: A })
        await provideToSP(dec(105, 18), { from: B })
        await provideToSP(dec(105, 18), { from: C })
        await provideToSP(dec(105, 18), { from: D })

        // time passes
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)

        // B deposits.
        await provideToSP(dec(5, 18), { from: B })

        // Price drops, defaulter is liquidated, A, B, C, D earn collateral
        await priceFeed.setPrice(dec(105, 18))
        assert.isFalse(await th.checkRecoveryMode(contracts))

        await troveManager.liquidate(defaulter_1)

        // Price bounces back
        await priceFeed.setPrice(dec(200, 18))

        // A B,C, D fully withdraw from the pool
        await stabilityPool.withdrawFromSP(dec(105, 18), { from: A })
        await stabilityPool.withdrawFromSP(dec(105, 18), { from: B })
        await stabilityPool.withdrawFromSP(dec(105, 18), { from: C })
        await stabilityPool.withdrawFromSP(dec(105, 18), { from: D })

        // --- TEST ---

        // get current collateral balances
        const A_CollateralBalance_Before = await getCollateralBalance(A)
        const B_CollateralBalance_Before = await getCollateralBalance(B)
        const C_CollateralBalance_Before = await getCollateralBalance(C)
        const D_CollateralBalance_Before = await getCollateralBalance(D)

        // A, B, C, D provide to SP
        await provideToSP(dec(100, 18), { from: A, gasPrice: 0 })
        await provideToSP(dec(200, 18), { from: B, gasPrice: 0 })
        await provideToSP(dec(300, 18), { from: C, gasPrice: 0 })
        await provideToSP(dec(400, 18), { from: D, gasPrice: 0 })

        // Get collateral balances after
        const A_CollateralBalance_After = await getCollateralBalance(A)
        const B_CollateralBalance_After = await getCollateralBalance(B)
        const C_CollateralBalance_After = await getCollateralBalance(C)
        const D_CollateralBalance_After = await getCollateralBalance(D)

        // Check collateral balances have not changed
        assert.isTrue(A_CollateralBalance_After.eq(A_CollateralBalance_Before))
        assert.isTrue(B_CollateralBalance_After.eq(B_CollateralBalance_Before))
        assert.isTrue(C_CollateralBalance_After.eq(C_CollateralBalance_Before))
        assert.isTrue(D_CollateralBalance_After.eq(D_CollateralBalance_Before))
      })

      it("provideToSP(): reverts when amount is zero", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        await openTrove({ extraTHUSDAmount: toBN(dec(1000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
        await openTrove({ extraTHUSDAmount: toBN(dec(2000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })

        // Whale transfers THUSD to C, D
        await thusdToken.transfer(C, dec(100, 18), { from: whale })
        await thusdToken.transfer(D, dec(100, 18), { from: whale })

        txPromise_A = provideToSP(0, { from: A })
        txPromise_B = provideToSP(0, { from: B })
        txPromise_C = provideToSP(0, { from: C })
        txPromise_D = provideToSP(0, { from: D })

        await th.assertRevert(txPromise_A, 'StabilityPool: Amount must be non-zero')
        await th.assertRevert(txPromise_B, 'StabilityPool: Amount must be non-zero')
        await th.assertRevert(txPromise_C, 'StabilityPool: Amount must be non-zero')
        await th.assertRevert(txPromise_D, 'StabilityPool: Amount must be non-zero')
      })

      // --- withdrawFromSP ---

      it("withdrawFromSP(): reverts when user has no active deposit", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(100, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(100, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

        await provideToSP(dec(100, 18), { from: alice })

        const alice_initialDeposit = (await stabilityPool.deposits(alice)).toString()
        const bob_initialDeposit = (await stabilityPool.deposits(bob)).toString()

        assert.equal(alice_initialDeposit, dec(100, 18))
        assert.equal(bob_initialDeposit, '0')

        const txAlice = await stabilityPool.withdrawFromSP(dec(100, 18), { from: alice })
        assert.isTrue(txAlice.receipt.status)


        try {
          const txBob = await stabilityPool.withdrawFromSP(dec(100, 18), { from: bob })
          assert.isFalse(txBob.receipt.status)
        } catch (err) {
          assert.include(err.message, "revert")
          // TODO: infamous issue #99
          //assert.include(err.message, "User must have a non-zero deposit")

        }
      })

      it("withdrawFromSP(): reverts when amount > 0 and system has an undercollateralized trove", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(100, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

        await provideToSP(dec(100, 18), { from: alice })

        const alice_initialDeposit = (await stabilityPool.deposits(alice)).toString()
        assert.equal(alice_initialDeposit, dec(100, 18))

        // defaulter opens trove
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // ETH/token drops, defaulter is in liquidation range (but not liquidated yet)
        await priceFeed.setPrice(dec(100, 18))

        await th.assertRevert(stabilityPool.withdrawFromSP(dec(100, 18), { from: alice }))
      })

      it("withdrawFromSP(): partial retrieval - retrieves correct THUSD amount and the entire collateral Gain, and updates deposit", async () => {
        // --- SETUP ---
        // Whale deposits 185000 THUSD in StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1, 24)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await provideToSP(dec(185000, 18), { from: whale })

        // 2 Troves opened
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })

        // --- TEST ---

        // Alice makes deposit #1: 15000 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        await provideToSP(dec(15000, 18), { from: alice })

        // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
        await priceFeed.setPrice(dec(105, 18));

        // 2 users with Trove with 170 THUSD drawn are closed
        const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner })  // 170 THUSD closed
        const liquidationTX_2 = await troveManager.liquidate(defaulter_2, { from: owner }) // 170 THUSD closed

        const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1)
        const [liquidatedDebt_2] = await th.getEmittedLiquidationValues(liquidationTX_2)

        // Alice THUSDLoss is ((15000/200000) * liquidatedDebt), for each liquidation
        const expectedTHUSDLoss_A = (liquidatedDebt_1.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18))))
          .add(liquidatedDebt_2.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18))))

        const expectedCompoundedTHUSDDeposit_A = toBN(dec(15000, 18)).sub(expectedTHUSDLoss_A)
        const compoundedTHUSDDeposit_A = await stabilityPool.getCompoundedTHUSDDeposit(alice)

        assert.isAtMost(th.getDifference(expectedCompoundedTHUSDDeposit_A, compoundedTHUSDDeposit_A), 100000)

        // Alice retrieves part of her entitled THUSD: 9000 THUSD
        await stabilityPool.withdrawFromSP(dec(9000, 18), { from: alice })

        const expectedNewDeposit_A = (compoundedTHUSDDeposit_A.sub(toBN(dec(9000, 18))))

        // check Alice's deposit has been updated to equal her compounded deposit minus her withdrawal */
        const newDeposit = (await stabilityPool.deposits(alice)).toString()
        assert.isAtMost(th.getDifference(newDeposit, expectedNewDeposit_A), 100000)

        // Expect Alice has withdrawn all collateral gain
        const alice_pendingCollateralGain = await stabilityPool.getDepositorCollateralGain(alice)
        assert.equal(alice_pendingCollateralGain, 0)
      })

      it("withdrawFromSP(): partial retrieval - leaves the correct amount of THUSD in the Stability Pool", async () => {
        // --- SETUP ---
        // Whale deposits 185000 THUSD in StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1, 24)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await provideToSP(dec(185000, 18), { from: whale })

        // 2 Troves opened
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })
        // --- TEST ---

        // Alice makes deposit #1: 15000 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        await provideToSP(dec(15000, 18), { from: alice })

        const SP_THUSD_Before = await stabilityPool.getTotalTHUSDDeposits()
        assert.equal(SP_THUSD_Before, dec(200000, 18))

        // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
        await priceFeed.setPrice(dec(105, 18));

        // 2 users liquidated
        const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner })
        const liquidationTX_2 = await troveManager.liquidate(defaulter_2, { from: owner })

        const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1)
        const [liquidatedDebt_2] = await th.getEmittedLiquidationValues(liquidationTX_2)

        // Alice retrieves part of her entitled THUSD: 9000 THUSD
        await stabilityPool.withdrawFromSP(dec(9000, 18), { from: alice })

        /* Check SP has reduced from 2 liquidations and Alice's withdrawal
        Expect THUSD in SP = (200000 - liquidatedDebt_1 - liquidatedDebt_2 - 9000) */
        const expectedSPTHUSD = toBN(dec(200000, 18))
          .sub(toBN(liquidatedDebt_1))
          .sub(toBN(liquidatedDebt_2))
          .sub(toBN(dec(9000, 18)))

        const SP_THUSD_After = (await stabilityPool.getTotalTHUSDDeposits()).toString()

        th.assertIsApproximatelyEqual(SP_THUSD_After, expectedSPTHUSD)
      })

      it("withdrawFromSP(): full retrieval - leaves the correct amount of THUSD in the Stability Pool", async () => {
        // --- SETUP ---
        // Whale deposits 185000 THUSD in StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await provideToSP(dec(185000, 18), { from: whale })

        // 2 Troves opened
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })

        // --- TEST ---

        // Alice makes deposit #1
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        await provideToSP(dec(15000, 18), { from: alice })

        const SP_THUSD_Before = await stabilityPool.getTotalTHUSDDeposits()
        assert.equal(SP_THUSD_Before, dec(200000, 18))

        // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
        await priceFeed.setPrice(dec(105, 18));

        // 2 defaulters liquidated
        const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner })
        const liquidationTX_2 = await troveManager.liquidate(defaulter_2, { from: owner })

        const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1)
        const [liquidatedDebt_2] = await th.getEmittedLiquidationValues(liquidationTX_2)

        // Alice THUSDLoss is ((15000/200000) * liquidatedDebt), for each liquidation
        const expectedTHUSDLoss_A = (liquidatedDebt_1.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18))))
          .add(liquidatedDebt_2.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18))))

        const expectedCompoundedTHUSDDeposit_A = toBN(dec(15000, 18)).sub(expectedTHUSDLoss_A)
        const compoundedTHUSDDeposit_A = await stabilityPool.getCompoundedTHUSDDeposit(alice)

        assert.isAtMost(th.getDifference(expectedCompoundedTHUSDDeposit_A, compoundedTHUSDDeposit_A), 100000)

        const THUSDinSPBefore = await stabilityPool.getTotalTHUSDDeposits()

        // Alice retrieves all of her entitled THUSD:
        await stabilityPool.withdrawFromSP(dec(15000, 18), { from: alice })

        const expectedTHUSDinSPAfter = THUSDinSPBefore.sub(compoundedTHUSDDeposit_A)

        const THUSDinSPAfter = await stabilityPool.getTotalTHUSDDeposits()
        assert.isAtMost(th.getDifference(expectedTHUSDinSPAfter, THUSDinSPAfter), 100000)
      })

      it("withdrawFromSP(): Subsequent deposit and withdrawal attempt from same account, with no intermediate liquidations, withdraws zero collateral", async () => {
        // --- SETUP ---
        // Whale deposits 1850 THUSD in StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await provideToSP(dec(18500, 18), { from: whale })

        // 2 defaulters open
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })

        // --- TEST ---

        // Alice makes deposit #1: 15000 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        await provideToSP(dec(15000, 18), { from: alice })

        // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
        await priceFeed.setPrice(dec(105, 18));

        // defaulters liquidated
        await troveManager.liquidate(defaulter_1, { from: owner })
        await troveManager.liquidate(defaulter_2, { from: owner })

        // Alice retrieves all of her entitled THUSD:
        await stabilityPool.withdrawFromSP(dec(15000, 18), { from: alice })
        assert.equal(await stabilityPool.getDepositorCollateralGain(alice), 0)

        // Alice makes second deposit
        await provideToSP(dec(10000, 18), { from: alice })
        assert.equal(await stabilityPool.getDepositorCollateralGain(alice), 0)

        const collateralInSP_Before = (await stabilityPool.getCollateralBalance()).toString()

        // Alice attempts second withdrawal
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
        assert.equal(await stabilityPool.getDepositorCollateralGain(alice), 0)

        // Check collateral in pool does not change
        const collateralInSP_1 = (await stabilityPool.getCollateralBalance()).toString()
        assert.equal(collateralInSP_Before, collateralInSP_1)

        // Third deposit
        await provideToSP(dec(10000, 18), { from: alice })
        assert.equal(await stabilityPool.getDepositorCollateralGain(alice), 0)

        // Alice attempts third withdrawal (this time, frm SP to Trove)
        const txPromise_A = stabilityPool.withdrawCollateralGainToTrove(alice, alice, { from: alice })
        await th.assertRevert(txPromise_A)
      })

      it("withdrawFromSP(): it correctly updates the user's THUSD and collateral snapshots of entitled reward per unit staked", async () => {
        // --- SETUP ---
        // Whale deposits 185000 THUSD in StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await provideToSP(dec(185000, 18), { from: whale })

        // 2 defaulters open
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })

        // --- TEST ---

        // Alice makes deposit #1: 15000 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        await provideToSP(dec(15000, 18), { from: alice })

        // check 'Before' snapshots
        const alice_snapshot_Before = await stabilityPool.depositSnapshots(alice)
        const alice_snapshot_S_Before = alice_snapshot_Before[0].toString()
        const alice_snapshot_P_Before = alice_snapshot_Before[1].toString()
        assert.equal(alice_snapshot_S_Before, 0)
        assert.equal(alice_snapshot_P_Before, '1000000000000000000')

        // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
        await priceFeed.setPrice(dec(105, 18));

        // 2 defaulters liquidated
        await troveManager.liquidate(defaulter_1, { from: owner })
        await troveManager.liquidate(defaulter_2, { from: owner });

        // Alice retrieves part of her entitled THUSD: 9000 THUSD
        await stabilityPool.withdrawFromSP(dec(9000, 18), { from: alice })

        const P = (await stabilityPool.P()).toString()
        const S = (await stabilityPool.epochToScaleToSum(0, 0)).toString()
        // check 'After' snapshots
        const alice_snapshot_After = await stabilityPool.depositSnapshots(alice)
        const alice_snapshot_S_After = alice_snapshot_After[0].toString()
        const alice_snapshot_P_After = alice_snapshot_After[1].toString()
        assert.equal(alice_snapshot_S_After, S)
        assert.equal(alice_snapshot_P_After, P)
      })

      it("withdrawFromSP(): decreases StabilityPool collateral", async () => {
        // --- SETUP ---
        // Whale deposits 185000 THUSD in StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await provideToSP(dec(185000, 18), { from: whale })

        // 1 defaulter opens
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // --- TEST ---

        // Alice makes deposit #1: 15000 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        await provideToSP(dec(15000, 18), { from: alice })

        // price drops: defaulter's Trove falls below MCR, alice and whale Trove remain active
        await priceFeed.setPrice('100000000000000000000');

        // defaulter's Trove is closed.
        const liquidationTx_1 = await troveManager.liquidate(defaulter_1, { from: owner })  // 180 THUSD closed
        const [, liquidatedColl,] = th.getEmittedLiquidationValues(liquidationTx_1)

        //Get ActivePool and StabilityPool collateral before retrieval:
        const active_Collateral_Before = await activePool.getCollateralBalance()
        const stability_Collateral_Before = await stabilityPool.getCollateralBalance()

        // Expect alice to be entitled to 15000/200000 of the liquidated coll
        const aliceExpectedCollateralGain = liquidatedColl.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18)))
        const aliceCollateralGain = await stabilityPool.getDepositorCollateralGain(alice)
        assert.isTrue(aliceExpectedCollateralGain.eq(aliceCollateralGain))

        // Alice retrieves all of her deposit
        await stabilityPool.withdrawFromSP(dec(15000, 18), { from: alice })

        const active_Collateral_After = await activePool.getCollateralBalance()
        const stability_Collateral_After = await stabilityPool.getCollateralBalance()

        const active_Collateral_Difference = (active_Collateral_Before.sub(active_Collateral_After))
        const stability_Collateral_Difference = (stability_Collateral_Before.sub(stability_Collateral_After))

        assert.equal(active_Collateral_Difference, '0')

        // Expect StabilityPool to have decreased by Alice's CollateralGain
        assert.isAtMost(th.getDifference(stability_Collateral_Difference, aliceCollateralGain), 10000)
      })

      it("withdrawFromSP(): All depositors are able to withdraw from the SP to their account", async () => {
        // Whale opens trove
        await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // 1 defaulter open
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // 6 Accounts open troves and provide to SP
        const depositors = [alice, bob, carol, dennis, erin, flyn]
        for (account of depositors) {
          await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: account } })
          await provideToSP(dec(10000, 18), { from: account })
        }

        await priceFeed.setPrice(dec(105, 18))
        await troveManager.liquidate(defaulter_1)

        await priceFeed.setPrice(dec(200, 18))

        // All depositors attempt to withdraw
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
        assert.equal((await stabilityPool.deposits(alice)).toString(), '0')
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
        assert.equal((await stabilityPool.deposits(alice)).toString(), '0')
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })
        assert.equal((await stabilityPool.deposits(alice)).toString(), '0')
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: dennis })
        assert.equal((await stabilityPool.deposits(alice)).toString(), '0')
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: erin })
        assert.equal((await stabilityPool.deposits(alice)).toString(), '0')
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: flyn })
        assert.equal((await stabilityPool.deposits(alice)).toString(), '0')

        const totalDeposits = (await stabilityPool.getTotalTHUSDDeposits()).toString()

        assert.isAtMost(th.getDifference(totalDeposits, '0'), 100000)
      })

      it("withdrawFromSP(): increases depositor's THUSD token balance by the expected amount", async () => {
        // Whale opens trove
        await openTrove({ extraTHUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // 1 defaulter opens trove
        const etherAmount = isCollateralERC20 ? 0 : dec(100, 'ether')
        await borrowerOperations.openTrove(th._100pct, await getOpenTroveTHUSDAmount(dec(10000, 18)), dec(100, 'ether'), defaulter_1, defaulter_1, { from: defaulter_1, value: etherAmount})

        const defaulterDebt = (await troveManager.getEntireDebtAndColl(defaulter_1))[0]

        // 6 Accounts open troves and provide to SP
        const depositors = [alice, bob, carol, dennis, erin, flyn]
        for (account of depositors) {
          await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: account } })
          await provideToSP(dec(10000, 18), { from: account })
        }

        await priceFeed.setPrice(dec(105, 18))
        await troveManager.liquidate(defaulter_1)

        const aliceBalBefore = await thusdToken.balanceOf(alice)
        const bobBalBefore = await thusdToken.balanceOf(bob)

        /* From an offset of 10000 THUSD, each depositor receives
        THUSDLoss = 1666.6666666666666666 THUSD

        and thus with a deposit of 10000 THUSD, each should withdraw 8333.3333333333333333 THUSD (in practice, slightly less due to rounding error)
        */

        // Price bounces back to $200 per ETH/token
        await priceFeed.setPrice(dec(200, 18))

        // Bob issues a further 5000 THUSD from his trove
        await borrowerOperations.withdrawTHUSD(th._100pct, dec(5000, 18), bob, bob, { from: bob })

        // Expect Alice's THUSD balance increase be very close to 8333.3333333333333333 THUSD
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
        const aliceBalance = (await thusdToken.balanceOf(alice))

        assert.isAtMost(th.getDifference(aliceBalance.sub(aliceBalBefore), '8333333333333333333333'), 100000)

        // expect Bob's THUSD balance increase to be very close to  13333.33333333333333333 THUSD
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
        const bobBalance = (await thusdToken.balanceOf(bob))
        assert.isAtMost(th.getDifference(bobBalance.sub(bobBalBefore), '13333333333333333333333'), 100000)
      })

      it("withdrawFromSP(): doesn't impact other users Stability deposits or collateral gains", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        await provideToSP(dec(10000, 18), { from: alice })
        await provideToSP(dec(20000, 18), { from: bob })
        await provideToSP(dec(30000, 18), { from: carol })

        // Would-be defaulters open troves
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })

        // Price drops
        await priceFeed.setPrice(dec(105, 18))

        // Defaulters are liquidated
        await troveManager.liquidate(defaulter_1)
        await troveManager.liquidate(defaulter_2)
        assert.isFalse(await sortedTroves.contains(defaulter_1))
        assert.isFalse(await sortedTroves.contains(defaulter_2))

        const alice_THUSDDeposit_Before = (await stabilityPool.getCompoundedTHUSDDeposit(alice)).toString()
        const bob_THUSDDeposit_Before = (await stabilityPool.getCompoundedTHUSDDeposit(bob)).toString()

        const alice_CollateralGain_Before = (await stabilityPool.getDepositorCollateralGain(alice)).toString()
        const bob_CollateralGain_Before = (await stabilityPool.getDepositorCollateralGain(bob)).toString()

        //check non-zero THUSD and CollateralGain in the Stability Pool
        const THUSDinSP = await stabilityPool.getTotalTHUSDDeposits()
        const collateralInSP = await stabilityPool.getCollateralBalance()
        assert.isTrue(THUSDinSP.gt(mv._zeroBN))
        assert.isTrue(collateralInSP.gt(mv._zeroBN))

        // Price rises
        await priceFeed.setPrice(dec(200, 18))

        // Carol withdraws her Stability deposit
        assert.equal((await stabilityPool.deposits(carol)).toString(), dec(30000, 18))
        await stabilityPool.withdrawFromSP(dec(30000, 18), { from: carol })
        assert.equal((await stabilityPool.deposits(carol)).toString(), '0')

        const alice_THUSDDeposit_After = (await stabilityPool.getCompoundedTHUSDDeposit(alice)).toString()
        const bob_THUSDDeposit_After = (await stabilityPool.getCompoundedTHUSDDeposit(bob)).toString()

        const alice_CollateralGain_After = (await stabilityPool.getDepositorCollateralGain(alice)).toString()
        const bob_CollateralGain_After = (await stabilityPool.getDepositorCollateralGain(bob)).toString()

        // Check compounded deposits and collateral gains for A and B have not changed
        assert.equal(alice_THUSDDeposit_Before, alice_THUSDDeposit_After)
        assert.equal(bob_THUSDDeposit_Before, bob_THUSDDeposit_After)

        assert.equal(alice_CollateralGain_Before, alice_CollateralGain_After)
        assert.equal(bob_CollateralGain_Before, bob_CollateralGain_After)
      })

      it("withdrawFromSP(): doesn't impact system debt, collateral or TCR ", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        await provideToSP(dec(10000, 18), { from: alice })
        await provideToSP(dec(20000, 18), { from: bob })
        await provideToSP(dec(30000, 18), { from: carol })

        // Would-be defaulters open troves
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })

        // Price drops
        await priceFeed.setPrice(dec(105, 18))

        // Defaulters are liquidated
        await troveManager.liquidate(defaulter_1)
        await troveManager.liquidate(defaulter_2)
        assert.isFalse(await sortedTroves.contains(defaulter_1))
        assert.isFalse(await sortedTroves.contains(defaulter_2))

        // Price rises
        await priceFeed.setPrice(dec(200, 18))

        const activeDebt_Before = (await activePool.getTHUSDDebt()).toString()
        const defaultedDebt_Before = (await defaultPool.getTHUSDDebt()).toString()
        const activeColl_Before = (await activePool.getCollateralBalance()).toString()
        const defaultedColl_Before = (await defaultPool.getCollateralBalance()).toString()
        const TCR_Before = (await th.getTCR(contracts)).toString()

        // Carol withdraws her Stability deposit
        assert.equal((await stabilityPool.deposits(carol)).toString(), dec(30000, 18))
        await stabilityPool.withdrawFromSP(dec(30000, 18), { from: carol })
        assert.equal((await stabilityPool.deposits(carol)).toString(), '0')

        const activeDebt_After = (await activePool.getTHUSDDebt()).toString()
        const defaultedDebt_After = (await defaultPool.getTHUSDDebt()).toString()
        const activeColl_After = (await activePool.getCollateralBalance()).toString()
        const defaultedColl_After = (await defaultPool.getCollateralBalance()).toString()
        const TCR_After = (await th.getTCR(contracts)).toString()

        // Check total system debt, collateral and TCR have not changed after a Stability deposit is made
        assert.equal(activeDebt_Before, activeDebt_After)
        assert.equal(defaultedDebt_Before, defaultedDebt_After)
        assert.equal(activeColl_Before, activeColl_After)
        assert.equal(defaultedColl_Before, defaultedColl_After)
        assert.equal(TCR_Before, TCR_After)
      })

      it("withdrawFromSP(): doesn't impact any troves, including the caller's trove", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        // A, B and C provide to SP
        await provideToSP(dec(10000, 18), { from: alice })
        await provideToSP(dec(20000, 18), { from: bob })
        await provideToSP(dec(30000, 18), { from: carol })

        // Price drops
        await priceFeed.setPrice(dec(105, 18))
        const price = await priceFeed.getPrice()

        // Get debt, collateral and ICR of all existing troves
        const whale_Debt_Before = (await troveManager.Troves(whale))[0].toString()
        const alice_Debt_Before = (await troveManager.Troves(alice))[0].toString()
        const bob_Debt_Before = (await troveManager.Troves(bob))[0].toString()
        const carol_Debt_Before = (await troveManager.Troves(carol))[0].toString()

        const whale_Coll_Before = (await troveManager.Troves(whale))[1].toString()
        const alice_Coll_Before = (await troveManager.Troves(alice))[1].toString()
        const bob_Coll_Before = (await troveManager.Troves(bob))[1].toString()
        const carol_Coll_Before = (await troveManager.Troves(carol))[1].toString()

        const whale_ICR_Before = (await troveManager.getCurrentICR(whale, price)).toString()
        const alice_ICR_Before = (await troveManager.getCurrentICR(alice, price)).toString()
        const bob_ICR_Before = (await troveManager.getCurrentICR(bob, price)).toString()
        const carol_ICR_Before = (await troveManager.getCurrentICR(carol, price)).toString()

        // price rises
        await priceFeed.setPrice(dec(200, 18))

        // Carol withdraws her Stability deposit
        assert.equal((await stabilityPool.deposits(carol)).toString(), dec(30000, 18))
        await stabilityPool.withdrawFromSP(dec(30000, 18), { from: carol })
        assert.equal((await stabilityPool.deposits(carol)).toString(), '0')

        const whale_Debt_After = (await troveManager.Troves(whale))[0].toString()
        const alice_Debt_After = (await troveManager.Troves(alice))[0].toString()
        const bob_Debt_After = (await troveManager.Troves(bob))[0].toString()
        const carol_Debt_After = (await troveManager.Troves(carol))[0].toString()

        const whale_Coll_After = (await troveManager.Troves(whale))[1].toString()
        const alice_Coll_After = (await troveManager.Troves(alice))[1].toString()
        const bob_Coll_After = (await troveManager.Troves(bob))[1].toString()
        const carol_Coll_After = (await troveManager.Troves(carol))[1].toString()

        const whale_ICR_After = (await troveManager.getCurrentICR(whale, price)).toString()
        const alice_ICR_After = (await troveManager.getCurrentICR(alice, price)).toString()
        const bob_ICR_After = (await troveManager.getCurrentICR(bob, price)).toString()
        const carol_ICR_After = (await troveManager.getCurrentICR(carol, price)).toString()

        // Check all troves are unaffected by Carol's Stability deposit withdrawal
        assert.equal(whale_Debt_Before, whale_Debt_After)
        assert.equal(alice_Debt_Before, alice_Debt_After)
        assert.equal(bob_Debt_Before, bob_Debt_After)
        assert.equal(carol_Debt_Before, carol_Debt_After)

        assert.equal(whale_Coll_Before, whale_Coll_After)
        assert.equal(alice_Coll_Before, alice_Coll_After)
        assert.equal(bob_Coll_Before, bob_Coll_After)
        assert.equal(carol_Coll_Before, carol_Coll_After)

        assert.equal(whale_ICR_Before, whale_ICR_After)
        assert.equal(alice_ICR_Before, alice_ICR_After)
        assert.equal(bob_ICR_Before, bob_ICR_After)
        assert.equal(carol_ICR_Before, carol_ICR_After)
      })

      it("withdrawFromSP(): succeeds when amount is 0 and system has an undercollateralized trove", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(100, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })

        await provideToSP(dec(100, 18), { from: A })

        const A_initialDeposit = (await stabilityPool.deposits(A)).toString()
        assert.equal(A_initialDeposit, dec(100, 18))

        // defaulters opens trove
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })

        // collateral drops, defaulters are in liquidation range
        await priceFeed.setPrice(dec(105, 18))
        const price = await priceFeed.getPrice()
        assert.isTrue(await th.ICRbetween100and110(defaulter_1, troveManager, price))

        await th.fastForwardTime(timeValues.MINUTES_IN_ONE_WEEK, web3.currentProvider)

        // Liquidate d1
        await troveManager.liquidate(defaulter_1)
        assert.isFalse(await sortedTroves.contains(defaulter_1))

        // Check d2 is undercollateralized
        assert.isTrue(await th.ICRbetween100and110(defaulter_2, troveManager, price))
        assert.isTrue(await sortedTroves.contains(defaulter_2))

        const A_CollateralBalBefore = await getCollateralBalance(A)

        // Check Alice has gains to withdraw
        const A_pendingCollateralGain = await stabilityPool.getDepositorCollateralGain(A)
        assert.isTrue(A_pendingCollateralGain.gt(toBN('0')))

        // Check withdrawal of 0 succeeds
        const tx = await stabilityPool.withdrawFromSP(0, { from: A, gasPrice: 0 })
        assert.isTrue(tx.receipt.status)

        const A_CollateralBalAfter = await getCollateralBalance(A)

        // Check A's collateral balances have increased correctly
        assert.isTrue(A_CollateralBalAfter.sub(A_CollateralBalBefore).eq(A_pendingCollateralGain))
      })

      it("withdrawFromSP(): withdrawing 0 THUSD doesn't alter the caller's deposit or the total THUSD in the Stability Pool", async () => {
        // --- SETUP ---
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        // A, B, C provides 100, 50, 30 THUSD to SP
        await provideToSP(dec(100, 18), { from: alice })
        await provideToSP(dec(50, 18), { from: bob })
        await provideToSP(dec(30, 18), { from: carol })

        const bob_Deposit_Before = (await stabilityPool.getCompoundedTHUSDDeposit(bob)).toString()
        const THUSDinSP_Before = (await stabilityPool.getTotalTHUSDDeposits()).toString()

        assert.equal(THUSDinSP_Before, dec(180, 18))

        // Bob withdraws 0 THUSD from the Stability Pool
        await stabilityPool.withdrawFromSP(0, { from: bob })

        // check Bob's deposit and total THUSD in Stability Pool has not changed
        const bob_Deposit_After = (await stabilityPool.getCompoundedTHUSDDeposit(bob)).toString()
        const THUSDinSP_After = (await stabilityPool.getTotalTHUSDDeposits()).toString()

        assert.equal(bob_Deposit_Before, bob_Deposit_After)
        assert.equal(THUSDinSP_Before, THUSDinSP_After)
      })

      it("withdrawFromSP(): withdrawing 0 collateral Gain does not alter the caller's collateral balance, their trove collateral, or the collateral in the Stability Pool", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        // Would-be defaulter open trove
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // Price drops
        await priceFeed.setPrice(dec(105, 18))

        assert.isFalse(await th.checkRecoveryMode(contracts))

        // Defaulter 1 liquidated, full offset
        await troveManager.liquidate(defaulter_1)

        // Dennis opens trove and deposits to Stability Pool
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
        await provideToSP(dec(100, 18), { from: dennis })

        // Check Dennis has 0 CollateralGain
        const dennis_CollateralGain = (await stabilityPool.getDepositorCollateralGain(dennis)).toString()
        assert.equal(dennis_CollateralGain, '0')

        const dennis_CollateralBalance_Before = (await getCollateralBalance(dennis)).toString()
        const dennis_Collateral_Before = ((await troveManager.Troves(dennis))[1]).toString()
        const collateralInSP_Before = (await stabilityPool.getCollateralBalance()).toString()

        await priceFeed.setPrice(dec(200, 18))

        // Dennis withdraws his full deposit and CollateralGain to his account
        await stabilityPool.withdrawFromSP(dec(100, 18), { from: dennis, gasPrice: 0 })

        // Check withdrawal does not alter Dennis' collateral balance or his trove's collateral
        const dennis_CollateralBalance_After = (await getCollateralBalance(dennis)).toString()
        const dennis_Collateral_After = ((await troveManager.Troves(dennis))[1]).toString()
        const collateralInSP_After = (await stabilityPool.getCollateralBalance()).toString()

        assert.equal(dennis_CollateralBalance_Before, dennis_CollateralBalance_After)
        assert.equal(dennis_Collateral_Before, dennis_Collateral_After)

        // Check withdrawal has not altered the collateral in the Stability Pool
        assert.equal(collateralInSP_Before, collateralInSP_After)
      })

      it("withdrawFromSP(): Request to withdraw > caller's deposit only withdraws the caller's compounded deposit", async () => {
        // --- SETUP ---
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // A, B, C provide THUSD to SP
        await provideToSP(dec(10000, 18), { from: alice })
        await provideToSP(dec(20000, 18), { from: bob })
        await provideToSP(dec(30000, 18), { from: carol })

        // Price drops
        await priceFeed.setPrice(dec(105, 18))

        // Liquidate defaulter 1
        await troveManager.liquidate(defaulter_1)

        const alice_THUSD_Balance_Before = await thusdToken.balanceOf(alice)
        const bob_THUSD_Balance_Before = await thusdToken.balanceOf(bob)

        const alice_Deposit_Before = await stabilityPool.getCompoundedTHUSDDeposit(alice)
        const bob_Deposit_Before = await stabilityPool.getCompoundedTHUSDDeposit(bob)

        const THUSDinSP_Before = await stabilityPool.getTotalTHUSDDeposits()

        await priceFeed.setPrice(dec(200, 18))

        // Bob attempts to withdraws 1 wei more than his compounded deposit from the Stability Pool
        await stabilityPool.withdrawFromSP(bob_Deposit_Before.add(toBN(1)), { from: bob })

        // Check Bob's THUSD balance has risen by only the value of his compounded deposit
        const bob_expectedTHUSDBalance = (bob_THUSD_Balance_Before.add(bob_Deposit_Before)).toString()
        const bob_THUSD_Balance_After = (await thusdToken.balanceOf(bob)).toString()
        assert.equal(bob_THUSD_Balance_After, bob_expectedTHUSDBalance)

        // Alice attempts to withdraws 2309842309.000000000000000000 THUSD from the Stability Pool
        await stabilityPool.withdrawFromSP('2309842309000000000000000000', { from: alice })

        // Check Alice's THUSD balance has risen by only the value of her compounded deposit
        const alice_expectedTHUSDBalance = (alice_THUSD_Balance_Before.add(alice_Deposit_Before)).toString()
        const alice_THUSD_Balance_After = (await thusdToken.balanceOf(alice)).toString()
        assert.equal(alice_THUSD_Balance_After, alice_expectedTHUSDBalance)

        // Check THUSD in Stability Pool has been reduced by only Alice's compounded deposit and Bob's compounded deposit
        const expectedTHUSDinSP = (THUSDinSP_Before.sub(alice_Deposit_Before).sub(bob_Deposit_Before)).toString()
        const THUSDinSP_After = (await stabilityPool.getTotalTHUSDDeposits()).toString()
        assert.equal(THUSDinSP_After, expectedTHUSDinSP)
      })

      it("withdrawFromSP(): Request to withdraw 2^256-1 THUSD only withdraws the caller's compounded deposit", async () => {
        // --- SETUP ---
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // A, B, C open troves
        // A, B, C open troves
        // A, B, C open troves
        // A, B, C open troves
        // A, B, C open troves
        // A, B, C open troves
        // A, B, C open troves
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // A, B, C provides 100, 50, 30 THUSD to SP
        await provideToSP(dec(100, 18), { from: alice })
        await provideToSP(dec(50, 18), { from: bob })
        await provideToSP(dec(30, 18), { from: carol })

        // Price drops
        await priceFeed.setPrice(dec(100, 18))

        // Liquidate defaulter 1
        await troveManager.liquidate(defaulter_1)

        const bob_THUSD_Balance_Before = await thusdToken.balanceOf(bob)

        const bob_Deposit_Before = await stabilityPool.getCompoundedTHUSDDeposit(bob)

        const THUSDinSP_Before = await stabilityPool.getTotalTHUSDDeposits()

        const maxBytes32 = web3.utils.toBN("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")

        // Price drops
        await priceFeed.setPrice(dec(200, 18))

        // Bob attempts to withdraws maxBytes32 THUSD from the Stability Pool
        await stabilityPool.withdrawFromSP(maxBytes32, { from: bob })

        // Check Bob's THUSD balance has risen by only the value of his compounded deposit
        const bob_expectedTHUSDBalance = (bob_THUSD_Balance_Before.add(bob_Deposit_Before)).toString()
        const bob_THUSD_Balance_After = (await thusdToken.balanceOf(bob)).toString()
        assert.equal(bob_THUSD_Balance_After, bob_expectedTHUSDBalance)

        // Check THUSD in Stability Pool has been reduced by only  Bob's compounded deposit
        const expectedTHUSDinSP = (THUSDinSP_Before.sub(bob_Deposit_Before)).toString()
        const THUSDinSP_After = (await stabilityPool.getTotalTHUSDDeposits()).toString()
        assert.equal(THUSDinSP_After, expectedTHUSDinSP)
      })

      it("withdrawFromSP(): caller can withdraw full deposit and collateral gain during Recovery Mode", async () => {
        // --- SETUP ---

        // Price doubles
        await priceFeed.setPrice(dec(400, 18))
        await openTrove({ extraTHUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
        // Price halves
        await priceFeed.setPrice(dec(200, 18))

        // A, B, C open troves and make Stability Pool deposits
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(4, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(4, 18)), extraParams: { from: carol } })

        const ethValue = isCollateralERC20 ? 0 : dec(100, 'ether')
        await borrowerOperations.openTrove(th._100pct, await getOpenTroveTHUSDAmount(dec(10000, 18)), dec(100, 'ether'), defaulter_1, defaulter_1, { from: defaulter_1, value: ethValue })

        // A, B, C provides 10000, 5000, 3000 THUSD to SP
        await provideToSP(dec(10000, 18), { from: alice })
        await provideToSP(dec(5000, 18), { from: bob })
        await provideToSP(dec(3000, 18), { from: carol })

        // Price drops
        await priceFeed.setPrice(dec(105, 18))
        const price = await priceFeed.getPrice()

        assert.isTrue(await th.checkRecoveryMode(contracts))

        // Liquidate defaulter 1
        await troveManager.liquidate(defaulter_1)
        assert.isFalse(await sortedTroves.contains(defaulter_1))

        const alice_THUSD_Balance_Before = await thusdToken.balanceOf(alice)
        const bob_THUSD_Balance_Before = await thusdToken.balanceOf(bob)
        const carol_THUSD_Balance_Before = await thusdToken.balanceOf(carol)

        const alice_Collateral_Balance_Before = await getCollateralBalance(alice)
        const bob_Collateral_Balance_Before = await getCollateralBalance(bob)
        const carol_Collateral_Balance_Before = await getCollateralBalance(carol)

        const alice_Deposit_Before = await stabilityPool.getCompoundedTHUSDDeposit(alice)
        const bob_Deposit_Before = await stabilityPool.getCompoundedTHUSDDeposit(bob)
        const carol_Deposit_Before = await stabilityPool.getCompoundedTHUSDDeposit(carol)

        const alice_CollateralGain_Before = await stabilityPool.getDepositorCollateralGain(alice)
        const bob_CollateralGain_Before = await stabilityPool.getDepositorCollateralGain(bob)
        const carol_CollateralGain_Before = await stabilityPool.getDepositorCollateralGain(carol)

        const THUSDinSP_Before = await stabilityPool.getTotalTHUSDDeposits()

        // Price rises
        await priceFeed.setPrice(dec(220, 18))

        assert.isTrue(await th.checkRecoveryMode(contracts))

        // A, B, C withdraw their full deposits from the Stability Pool
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice, gasPrice: 0 })
        await stabilityPool.withdrawFromSP(dec(5000, 18), { from: bob, gasPrice: 0 })
        await stabilityPool.withdrawFromSP(dec(3000, 18), { from: carol, gasPrice: 0 })

        // Check THUSD balances of A, B, C have risen by the value of their compounded deposits, respectively
        const alice_expectedTHUSDBalance = (alice_THUSD_Balance_Before.add(alice_Deposit_Before)).toString()

        const bob_expectedTHUSDBalance = (bob_THUSD_Balance_Before.add(bob_Deposit_Before)).toString()
        const carol_expectedTHUSDBalance = (carol_THUSD_Balance_Before.add(carol_Deposit_Before)).toString()

        const alice_THUSD_Balance_After = (await thusdToken.balanceOf(alice)).toString()

        const bob_THUSD_Balance_After = (await thusdToken.balanceOf(bob)).toString()
        const carol_THUSD_Balance_After = (await thusdToken.balanceOf(carol)).toString()

        assert.equal(alice_THUSD_Balance_After, alice_expectedTHUSDBalance)
        assert.equal(bob_THUSD_Balance_After, bob_expectedTHUSDBalance)
        assert.equal(carol_THUSD_Balance_After, carol_expectedTHUSDBalance)

        // Check collateral balances of A, B, C have increased by the value of their collateral gain from liquidations, respectively
        const alice_expectedCollateralBalance = (alice_Collateral_Balance_Before.add(alice_CollateralGain_Before)).toString()
        const bob_expectedCollateralBalance = (bob_Collateral_Balance_Before.add(bob_CollateralGain_Before)).toString()
        const carol_expectedCollateralBalance = (carol_Collateral_Balance_Before.add(carol_CollateralGain_Before)).toString()

        const alice_CollateralBalance_After = (await getCollateralBalance(alice)).toString()
        const bob_CollateralBalance_After = (await getCollateralBalance(bob)).toString()
        const carol_CollateralBalance_After = (await getCollateralBalance(carol)).toString()

        assert.equal(alice_expectedCollateralBalance, alice_CollateralBalance_After)
        assert.equal(bob_expectedCollateralBalance, bob_CollateralBalance_After)
        assert.equal(carol_expectedCollateralBalance, carol_CollateralBalance_After)

        // Check THUSD in Stability Pool has been reduced by A, B and C's compounded deposit
        const expectedTHUSDinSP = (THUSDinSP_Before
          .sub(alice_Deposit_Before)
          .sub(bob_Deposit_Before)
          .sub(carol_Deposit_Before))
          .toString()
        const THUSDinSP_After = (await stabilityPool.getTotalTHUSDDeposits()).toString()
        assert.equal(THUSDinSP_After, expectedTHUSDinSP)

        // Check collateral in SP has reduced to zero
        const collateralInSP_After = (await stabilityPool.getCollateralBalance()).toString()
        assert.isAtMost(th.getDifference(collateralInSP_After, '0'), 100000)
      })

      it("getDepositorCollateralGain(): depositor does not earn further collateral gains from liquidations while their compounded deposit == 0: ", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(1, 24)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // A, B, C open troves
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        // defaulters open troves
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_2 } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_3 } })

        // A, B, provide 10000, 5000 THUSD to SP
        await provideToSP(dec(10000, 18), { from: alice })
        await provideToSP(dec(5000, 18), { from: bob })

        //price drops
        await priceFeed.setPrice(dec(105, 18))

        // Liquidate defaulter 1. Empties the Pool
        await troveManager.liquidate(defaulter_1)
        assert.isFalse(await sortedTroves.contains(defaulter_1))

        const THUSDinSP = (await stabilityPool.getTotalTHUSDDeposits()).toString()
        assert.equal(THUSDinSP, '0')

        // Check Stability deposits have been fully cancelled with debt, and are now all zero
        const alice_Deposit = (await stabilityPool.getCompoundedTHUSDDeposit(alice)).toString()
        const bob_Deposit = (await stabilityPool.getCompoundedTHUSDDeposit(bob)).toString()

        assert.equal(alice_Deposit, '0')
        assert.equal(bob_Deposit, '0')

        // Get collateral gain for A and B
        const alice_CollateralGain_1 = (await stabilityPool.getDepositorCollateralGain(alice)).toString()
        const bob_CollateralGain_1 = (await stabilityPool.getDepositorCollateralGain(bob)).toString()

        // Whale deposits 10000 THUSD to Stability Pool
        await provideToSP(dec(1, 24), { from: whale })

        // Liquidation 2
        await troveManager.liquidate(defaulter_2)
        assert.isFalse(await sortedTroves.contains(defaulter_2))

        // Check Alice and Bob have not received collateral gain from liquidation 2 while their deposit was 0
        const alice_CollateralGain_2 = (await stabilityPool.getDepositorCollateralGain(alice)).toString()
        const bob_CollateralGain_2 = (await stabilityPool.getDepositorCollateralGain(bob)).toString()

        assert.equal(alice_CollateralGain_1, alice_CollateralGain_2)
        assert.equal(bob_CollateralGain_1, bob_CollateralGain_2)

        // Liquidation 3
        await troveManager.liquidate(defaulter_3)
        assert.isFalse(await sortedTroves.contains(defaulter_3))

        // Check Alice and Bob have not received collateral gain from liquidation 3 while their deposit was 0
        const alice_CollateralGain_3 = (await stabilityPool.getDepositorCollateralGain(alice)).toString()
        const bob_CollateralGain_3 = (await stabilityPool.getDepositorCollateralGain(bob)).toString()

        assert.equal(alice_CollateralGain_1, alice_CollateralGain_3)
        assert.equal(bob_CollateralGain_1, bob_CollateralGain_3)
      })

      // --- PCV functionality ---
      it("withdrawFromSP(), full withdrawal: zero's depositor's snapshots", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        await openTrove({  ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        //  SETUP: Execute a series of operations to make G, S > 0 and P < 1

        // E opens trove and makes a deposit
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: E } })
        await provideToSP(dec(10000, 18), { from: E })

        // Fast-forward time and make a second deposit
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)
        await provideToSP(dec(10000, 18), { from: E })

        // perform a liquidation to make 0 < P < 1, and S > 0
        await priceFeed.setPrice(dec(105, 18))
        assert.isFalse(await th.checkRecoveryMode(contracts))

        await troveManager.liquidate(defaulter_1)

        const currentEpoch = await stabilityPool.currentEpoch()
        const currentScale = await stabilityPool.currentScale()

        const S_Before = await stabilityPool.epochToScaleToSum(currentEpoch, currentScale)
        const P_Before = await stabilityPool.P()

        // Confirm 0 < P < 1
        assert.isTrue(P_Before.gt(toBN('0')) && P_Before.lt(toBN(dec(1, 18))))
        // Confirm S, G are both > 0
        assert.isTrue(S_Before.gt(toBN('0')))

        // --- TEST ---

        // Whale transfers to A, B
        await thusdToken.transfer(A, dec(10000, 18), { from: whale })
        await thusdToken.transfer(B, dec(20000, 18), { from: whale })

        await priceFeed.setPrice(dec(200, 18))

        // C, D open troves
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: C } })
        await openTrove({ extraTHUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: D } })

        // A, B, C, D make their initial deposits
        await provideToSP(dec(10000, 18), { from: A })
        await provideToSP(dec(20000, 18), { from: B })
        await provideToSP(dec(30000, 18), { from: C })
        await provideToSP(dec(40000, 18), { from: D })

        // Check deposits snapshots are non-zero

        for (depositor of [A, B, C, D]) {
          const snapshot = await stabilityPool.depositSnapshots(depositor)

          const ZERO = toBN('0')
          // Check S,P, G snapshots are non-zero
          assert.isTrue(snapshot[0].eq(S_Before))  // S
          assert.isTrue(snapshot[1].eq(P_Before))  // P
          assert.equal(snapshot[2], '0')  // scale
          assert.equal(snapshot[3], '0')  // epoch
        }

        // All depositors make full withdrawal
        await stabilityPool.withdrawFromSP(dec(10000, 18), { from: A })
        await stabilityPool.withdrawFromSP(dec(20000, 18), { from: B })
        await stabilityPool.withdrawFromSP(dec(30000, 18), { from: C })
        await stabilityPool.withdrawFromSP(dec(40000, 18), { from: D })

        // Check all depositors' snapshots have been zero'd
        for (depositor of [A, B, C, D]) {
          const snapshot = await stabilityPool.depositSnapshots(depositor)

          // Check S, P, G snapshots are now zero
          assert.equal(snapshot[0], '0')  // S
          assert.equal(snapshot[1], '0')  // P
          assert.equal(snapshot[2], '0')  // scale
          assert.equal(snapshot[3], '0')  // epoch
        }
      })

      it("withdrawFromSP(), reverts when initial deposit value is 0", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // A opens trove and join the Stability Pool
        await openTrove({ extraTHUSDAmount: toBN(dec(10100, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
        await provideToSP(dec(10000, 18), { from: A })

        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        //  SETUP: Execute a series of operations to trigger collateral rewards for depositor A

        // Fast-forward time and make a second deposit
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)
        await provideToSP(dec(100, 18), { from: A })

        // perform a liquidation to make 0 < P < 1, and S > 0
        await priceFeed.setPrice(dec(105, 18))
        assert.isFalse(await th.checkRecoveryMode(contracts))

        await troveManager.liquidate(defaulter_1)
        assert.isFalse(await sortedTroves.contains(defaulter_1))

        await priceFeed.setPrice(dec(200, 18))

        // A successfully withraws deposit and all gains
        await stabilityPool.withdrawFromSP(dec(10100, 18), { from: A })

        // Confirm A's recorded deposit is 0
        const A_deposit = await stabilityPool.deposits(A)  // get initialValue property on deposit struct
        assert.equal(A_deposit, '0')

        // --- TEST ---
        const expectedRevertMessage = "StabilityPool: User must have a non-zero deposit"

        // Further withdrawal attempt from A
        const withdrawalPromise_A = stabilityPool.withdrawFromSP(dec(10000, 18), { from: A })
        await th.assertRevert(withdrawalPromise_A, expectedRevertMessage)

        // Withdrawal attempt of a non-existent deposit, from C
        const withdrawalPromise_C = stabilityPool.withdrawFromSP(dec(10000, 18), { from: C })
        await th.assertRevert(withdrawalPromise_C, expectedRevertMessage)
      })

      // --- withdrawCollateralGainToTrove ---

      it("withdrawCollateralGainToTrove(): reverts when user has no active deposit", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

        await provideToSP(dec(10000, 18), { from: alice })

        const alice_initialDeposit = (await stabilityPool.deposits(alice)).toString()
        const bob_initialDeposit = (await stabilityPool.deposits(bob)).toString()

        assert.equal(alice_initialDeposit, dec(10000, 18))
        assert.equal(bob_initialDeposit, '0')

        // Defaulter opens a trove, price drops, defaulter gets liquidated
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })
        await priceFeed.setPrice(dec(105, 18))
        assert.isFalse(await th.checkRecoveryMode(contracts))
        await troveManager.liquidate(defaulter_1)
        assert.isFalse(await sortedTroves.contains(defaulter_1))

        const txAlice = await stabilityPool.withdrawCollateralGainToTrove(alice, alice, { from: alice })
        assert.isTrue(txAlice.receipt.status)

        const txPromise_B = stabilityPool.withdrawCollateralGainToTrove(bob, bob, { from: bob })
        await th.assertRevert(txPromise_B)
      })

      it("withdrawCollateralGainToTrove(): Applies THUSDLoss to user's deposit, and redirects collateral reward to user's Trove", async () => {
        // --- SETUP ---
        // Whale deposits 185000 THUSD in StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await provideToSP(dec(185000, 18), { from: whale })

        // Defaulter opens trove
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // --- TEST ---

        // Alice makes deposit #1: 15000 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        await provideToSP(dec(15000, 18), { from: alice })

        // check Alice's Trove recorded collateral Before:
        const aliceTrove_Before = await troveManager.Troves(alice)
        const aliceTrove_Collateral_Before = aliceTrove_Before[1]
        assert.isTrue(aliceTrove_Collateral_Before.gt(toBN('0')))

        // price drops: defaulter's Trove falls below MCR, alice and whale Trove remain active
        await priceFeed.setPrice(dec(105, 18));

        // Defaulter's Trove is closed
        const liquidationTx_1 = await troveManager.liquidate(defaulter_1, { from: owner })
        const [liquidatedDebt, liquidatedColl, ,] = th.getEmittedLiquidationValues(liquidationTx_1)

        const CollateralGain_A = await stabilityPool.getDepositorCollateralGain(alice)
        const compoundedDeposit_A = await stabilityPool.getCompoundedTHUSDDeposit(alice)

        // Alice should receive rewards proportional to her deposit as share of total deposits
        const expectedCollateralGain_A = liquidatedColl.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18)))
        const expectedTHUSDLoss_A = liquidatedDebt.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18)))
        const expectedCompoundedDeposit_A = toBN(dec(15000, 18)).sub(expectedTHUSDLoss_A)

        assert.isAtMost(th.getDifference(expectedCompoundedDeposit_A, compoundedDeposit_A), 100000)

        // Alice sends her collateral Gains to her Trove
        await stabilityPool.withdrawCollateralGainToTrove(alice, alice, { from: alice })

        // check Alice's THUSDLoss has been applied to her deposit expectedCompoundedDeposit_A
        alice_deposit_afterDefault = await stabilityPool.deposits(alice)
        assert.isAtMost(th.getDifference(alice_deposit_afterDefault, expectedCompoundedDeposit_A), 100000)

        // check alice's Trove recorded collateral has increased by the expected reward amount
        const aliceTrove_After = await troveManager.Troves(alice)
        const aliceTrove_Collateral_After = aliceTrove_After[1]

        const Trove_Collateral_Increase = (aliceTrove_Collateral_After.sub(aliceTrove_Collateral_Before)).toString()

        assert.equal(Trove_Collateral_Increase, CollateralGain_A)
      })

      it("withdrawCollateralGainToTrove(): reverts if it would leave trove with ICR < MCR", async () => {
        // --- SETUP ---
        // Whale deposits 1850 THUSD in StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await provideToSP(dec(185000, 18), { from: whale })

        // defaulter opened
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // --- TEST ---

        // Alice makes deposit #1: 15000 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await provideToSP(dec(15000, 18), { from: alice })

        // check alice's Trove recorded collateral Before:
        const aliceTrove_Before = await troveManager.Troves(alice)
        const aliceTrove_Collateral_Before = aliceTrove_Before[1]
        assert.isTrue(aliceTrove_Collateral_Before.gt(toBN('0')))

        // price drops: defaulter's Trove falls below MCR
        await priceFeed.setPrice(dec(10, 18));

        // defaulter's Trove is closed.
        await troveManager.liquidate(defaulter_1, { from: owner })

        // Alice attempts to  her collateral Gains to her Trove
        await assertRevert(stabilityPool.withdrawCollateralGainToTrove(alice, alice, { from: alice }),
        // "BorrowerOps: An operation that would result in ICR < MCR is not permitted" // FIXME other error message, is it correct or not?
        )
      })

      it("withdrawCollateralGainToTrove(): Subsequent deposit and withdrawal attempt from same account, with no intermediate liquidations, withdraws zero collateral", async () => {
        // --- SETUP ---
        // Whale deposits 1850 THUSD in StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await provideToSP(dec(185000, 18), { from: whale })

        // defaulter opened
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // --- TEST ---

        // Alice makes deposit #1: 15000 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await provideToSP(dec(15000, 18), { from: alice })

        // check alice's Trove recorded collateral Before:
        const aliceTrove_Before = await troveManager.Troves(alice)
        const aliceTrove_Collateral_Before = aliceTrove_Before[1]
        assert.isTrue(aliceTrove_Collateral_Before.gt(toBN('0')))

        // price drops: defaulter's Trove falls below MCR
        await priceFeed.setPrice(dec(105, 18));

        // defaulter's Trove is closed.
        await troveManager.liquidate(defaulter_1, { from: owner })

        // price bounces back
        await priceFeed.setPrice(dec(200, 18));

        // Alice sends her collateral Gains to her Trove
        await stabilityPool.withdrawCollateralGainToTrove(alice, alice, { from: alice })

        assert.equal(await stabilityPool.getDepositorCollateralGain(alice), 0)

        const collateralInSP_Before = (await stabilityPool.getCollateralBalance()).toString()

        // Alice attempts second withdrawal from SP to Trove - reverts, due to 0 collateral Gain
        const txPromise_A = stabilityPool.withdrawCollateralGainToTrove(alice, alice, { from: alice })
        await th.assertRevert(txPromise_A)

        // Check collateral in pool does not change
        const collateralInSP_1 = (await stabilityPool.getCollateralBalance()).toString()
        assert.equal(collateralInSP_Before, collateralInSP_1)

        await priceFeed.setPrice(dec(200, 18));

        // Alice attempts third withdrawal (this time, from SP to her own account)
        await stabilityPool.withdrawFromSP(dec(15000, 18), { from: alice })

        // Check collateral in pool does not change
        const collateralInSP_2 = (await stabilityPool.getCollateralBalance()).toString()
        assert.equal(collateralInSP_Before, collateralInSP_2)
      })

      it("withdrawCollateralGainToTrove(): decreases StabilityPool collateral and increases activePool collateral", async () => {
        // --- SETUP ---
        // Whale deposits 185000 THUSD in StabilityPool
        await openTrove({ extraTHUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await provideToSP(dec(185000, 18), { from: whale })

        // defaulter opened
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // --- TEST ---

        // Alice makes deposit #1: 15000 THUSD
        await openTrove({ extraTHUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await provideToSP(dec(15000, 18), { from: alice })

        // price drops: defaulter's Trove falls below MCR
        await priceFeed.setPrice(dec(100, 18));

        // defaulter's Trove is closed.
        const liquidationTx = await troveManager.liquidate(defaulter_1)
        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        // Expect alice to be entitled to 15000/200000 of the liquidated coll
        const aliceExpectedCollateralGain = liquidatedColl.mul(toBN(dec(15000, 18))).div(toBN(dec(200000, 18)))
        const aliceCollateralGain = await stabilityPool.getDepositorCollateralGain(alice)
        assert.isTrue(aliceExpectedCollateralGain.eq(aliceCollateralGain))

        // price bounces back
        await priceFeed.setPrice(dec(200, 18));

        //check activePool and StabilityPool collateral before retrieval:
        const active_Collateral_Before = await activePool.getCollateralBalance()
        const stability_Collateral_Before = await stabilityPool.getCollateralBalance()

        // Alice retrieves redirects collateral gain to her Trove
        await stabilityPool.withdrawCollateralGainToTrove(alice, alice, { from: alice })

        const active_Collateral_After = await activePool.getCollateralBalance()
        const stability_Collateral_After = await stabilityPool.getCollateralBalance()

        const active_Collateral_Difference = (active_Collateral_After.sub(active_Collateral_Before)) // AP collateral should increase
        const stability_Collateral_Difference = (stability_Collateral_Before.sub(stability_Collateral_After)) // SP collateral should decrease

        // check Pool collateral values change by Alice's CollateralGain, i.e 0.075 ETH/token
        assert.isAtMost(th.getDifference(active_Collateral_Difference, aliceCollateralGain), 10000)
        assert.isAtMost(th.getDifference(stability_Collateral_Difference, aliceCollateralGain), 10000)
      })

      it("withdrawCollateralGainToTrove(): All depositors are able to withdraw their collateral gain from the SP to their Trove", async () => {
        // Whale opens trove
        await openTrove({ extraTHUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // Defaulter opens trove
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // 6 Accounts open troves and provide to SP
        const depositors = [alice, bob, carol, dennis, erin, flyn]
        for (account of depositors) {
          await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: account } })
          await provideToSP(dec(10000, 18), { from: account })
        }

        await priceFeed.setPrice(dec(105, 18))
        await troveManager.liquidate(defaulter_1)

        // price bounces back
        await priceFeed.setPrice(dec(200, 18));

        // All depositors attempt to withdraw
        const tx1 = await stabilityPool.withdrawCollateralGainToTrove(alice, alice, { from: alice })
        assert.isTrue(tx1.receipt.status)
        const tx2 = await stabilityPool.withdrawCollateralGainToTrove(bob, bob, { from: bob })
        assert.isTrue(tx1.receipt.status)
        const tx3 = await stabilityPool.withdrawCollateralGainToTrove(carol, carol, { from: carol })
        assert.isTrue(tx1.receipt.status)
        const tx4 = await stabilityPool.withdrawCollateralGainToTrove(dennis, dennis, { from: dennis })
        assert.isTrue(tx1.receipt.status)
        const tx5 = await stabilityPool.withdrawCollateralGainToTrove(erin, erin, { from: erin })
        assert.isTrue(tx1.receipt.status)
        const tx6 = await stabilityPool.withdrawCollateralGainToTrove(flyn, flyn, { from: flyn })
        assert.isTrue(tx1.receipt.status)
      })

      it("withdrawCollateralGainToTrove(): All depositors withdraw, each withdraw their correct collateral gain", async () => {
        // Whale opens trove
        await openTrove({ extraTHUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // defaulter opened
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // 6 Accounts open troves and provide to SP
        const depositors = [alice, bob, carol, dennis, erin, flyn]
        for (account of depositors) {
          await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: account } })
          await provideToSP(dec(10000, 18), { from: account })
        }
        const collBefore = (await troveManager.Troves(alice))[1] // all troves have same coll before

        await priceFeed.setPrice(dec(105, 18))
        const liquidationTx = await troveManager.liquidate(defaulter_1)
        const [, liquidatedColl, ,] = th.getEmittedLiquidationValues(liquidationTx)


        /* All depositors attempt to withdraw their collateral gain to their Trove. Each depositor
        receives (liquidatedColl/ 6).

        Thus, expected new collateral for each depositor with 1 collateral in their trove originally, is
        (1 + liquidatedColl/6)
        */

        const expectedCollGain= liquidatedColl.div(toBN('6'))

        await priceFeed.setPrice(dec(200, 18))

        await stabilityPool.withdrawCollateralGainToTrove(alice, alice, { from: alice })
        const aliceCollAfter = (await troveManager.Troves(alice))[1]
        assert.isAtMost(th.getDifference(aliceCollAfter.sub(collBefore), expectedCollGain), 10000)

        await stabilityPool.withdrawCollateralGainToTrove(bob, bob, { from: bob })
        const bobCollAfter = (await troveManager.Troves(bob))[1]
        assert.isAtMost(th.getDifference(bobCollAfter.sub(collBefore), expectedCollGain), 10000)

        await stabilityPool.withdrawCollateralGainToTrove(carol, carol, { from: carol })
        const carolCollAfter = (await troveManager.Troves(carol))[1]
        assert.isAtMost(th.getDifference(carolCollAfter.sub(collBefore), expectedCollGain), 10000)

        await stabilityPool.withdrawCollateralGainToTrove(dennis, dennis, { from: dennis })
        const dennisCollAfter = (await troveManager.Troves(dennis))[1]
        assert.isAtMost(th.getDifference(dennisCollAfter.sub(collBefore), expectedCollGain), 10000)

        await stabilityPool.withdrawCollateralGainToTrove(erin, erin, { from: erin })
        const erinCollAfter = (await troveManager.Troves(erin))[1]
        assert.isAtMost(th.getDifference(erinCollAfter.sub(collBefore), expectedCollGain), 10000)

        await stabilityPool.withdrawCollateralGainToTrove(flyn, flyn, { from: flyn })
        const flynCollAfter = (await troveManager.Troves(flyn))[1]
        assert.isAtMost(th.getDifference(flynCollAfter.sub(collBefore), expectedCollGain), 10000)
      })

      it("withdrawCollateralGainToTrove(): caller can withdraw full deposit and collateral gain to their trove during Recovery Mode", async () => {
        // --- SETUP ---

      // Defaulter opens
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // A, B, C open troves
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

        // A, B, C provides 10000, 5000, 3000 THUSD to SP
        await provideToSP(dec(10000, 18), { from: alice })
        await provideToSP(dec(5000, 18), { from: bob })
        await provideToSP(dec(3000, 18), { from: carol })

        assert.isFalse(await th.checkRecoveryMode(contracts))

        // Price drops to 105,
        await priceFeed.setPrice(dec(105, 18))
        const price = await priceFeed.getPrice()

        assert.isTrue(await th.checkRecoveryMode(contracts))

        // Check defaulter 1 has ICR: 100% < ICR < 110%.
        assert.isTrue(await th.ICRbetween100and110(defaulter_1, troveManager, price))

        const alice_Collateral_Before = (await troveManager.Troves(alice))[1]
        const bob_Collateral_Before = (await troveManager.Troves(bob))[1]
        const carol_Collateral_Before = (await troveManager.Troves(carol))[1]

        // Liquidate defaulter 1
        assert.isTrue(await sortedTroves.contains(defaulter_1))
        await troveManager.liquidate(defaulter_1)
        assert.isFalse(await sortedTroves.contains(defaulter_1))

        const alice_CollateralGain_Before = await stabilityPool.getDepositorCollateralGain(alice)
        const bob_CollateralGain_Before = await stabilityPool.getDepositorCollateralGain(bob)
        const carol_CollateralGain_Before = await stabilityPool.getDepositorCollateralGain(carol)

        // A, B, C withdraw their full collateral gain from the Stability Pool to their trove
        await stabilityPool.withdrawCollateralGainToTrove(alice, alice, { from: alice })
        await stabilityPool.withdrawCollateralGainToTrove(bob, bob, { from: bob })
        await stabilityPool.withdrawCollateralGainToTrove(carol, carol, { from: carol })

        // Check collateral of troves A, B, C has increased by the value of their collateral gain from liquidations, respectively
        const alice_expectedCollateral = (alice_Collateral_Before.add(alice_CollateralGain_Before)).toString()
        const bob_expectedColalteral = (bob_Collateral_Before.add(bob_CollateralGain_Before)).toString()
        const carol_expectedCollateral = (carol_Collateral_Before.add(carol_CollateralGain_Before)).toString()

        const alice_Collateral_After = (await troveManager.Troves(alice))[1]
        const bob_Collateral_After = (await troveManager.Troves(bob))[1]
        const carol_Collateral_After = (await troveManager.Troves(carol))[1]

        assert.equal(alice_expectedCollateral, alice_Collateral_After)
        assert.equal(bob_expectedColalteral, bob_Collateral_After)
        assert.equal(carol_expectedCollateral, carol_Collateral_After)

        // Check collateral in SP has reduced to zero
        const collateralInSP_After = (await stabilityPool.getCollateralBalance()).toString()
        assert.isAtMost(th.getDifference(collateralInSP_After, '0'), 100000)
      })

      it("withdrawCollateralGainToTrove(): reverts if user has no trove", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // A, B, C open troves
        await openTrove({ extraTHUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
        await openTrove({ extraTHUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
        await openTrove({ extraTHUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // Defaulter opens
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } })

        // A transfers THUSD to D
        await thusdToken.transfer(dennis, dec(10000, 18), { from: alice })

        // D deposits to Stability Pool
        await provideToSP(dec(10000, 18), { from: dennis })

        //Price drops
        await priceFeed.setPrice(dec(105, 18))

        //Liquidate defaulter 1
        await troveManager.liquidate(defaulter_1)
        assert.isFalse(await sortedTroves.contains(defaulter_1))

        await priceFeed.setPrice(dec(200, 18))

        // D attempts to withdraw his collateral gain to Trove
        await th.assertRevert(stabilityPool.withdrawCollateralGainToTrove(dennis, dennis, { from: dennis }), 
        "caller must have an active trove to withdraw collateralGain to")
      })

      it("withdrawCollateralGainToTrove(): reverts when depositor has no collateral gain", async () => {
        await openTrove({ extraTHUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

        // Whale transfers THUSD to A, B
        await thusdToken.transfer(A, dec(10000, 18), { from: whale })
        await thusdToken.transfer(B, dec(20000, 18), { from: whale })

        // C, D open troves
        await openTrove({ extraTHUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
        await openTrove({ extraTHUSDAmount: toBN(dec(4000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

        // A, B, C, D provide to SP
        await provideToSP(dec(10, 18), { from: A })
        await provideToSP(dec(20, 18), { from: B })
        await provideToSP(dec(30, 18), { from: C })
        await provideToSP(dec(40, 18), { from: D })

        // fastforward time, and E makes a deposit
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)
        await openTrove({ extraTHUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })
        await provideToSP(dec(3000, 18), { from: E })

        // Confirm A, B, C have zero collateral gain
        assert.equal(await stabilityPool.getDepositorCollateralGain(A), '0')
        assert.equal(await stabilityPool.getDepositorCollateralGain(B), '0')
        assert.equal(await stabilityPool.getDepositorCollateralGain(C), '0')

        // Check withdrawCollateralGainToTrove reverts for A, B, C
        const txPromise_A = stabilityPool.withdrawCollateralGainToTrove(A, A, { from: A })
        const txPromise_B = stabilityPool.withdrawCollateralGainToTrove(B, B, { from: B })
        const txPromise_C = stabilityPool.withdrawCollateralGainToTrove(C, C, { from: C })
        const txPromise_D = stabilityPool.withdrawCollateralGainToTrove(D, D, { from: D })

        await th.assertRevert(txPromise_A)
        await th.assertRevert(txPromise_B)
        await th.assertRevert(txPromise_C)
        await th.assertRevert(txPromise_D)
      })

    })
  }

  context("when collateral is ERC20 token", () => {
    contextTestStabilityPool( true )
  })

  context("when collateral is eth", () => {
    contextTestStabilityPool( false )
  })
})

contract('Reset chain state', async accounts => { })
