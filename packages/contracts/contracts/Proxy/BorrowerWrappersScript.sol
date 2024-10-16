// SPDX-License-Identifier: MIT

pragma solidity ^0.8.17;

import "../Dependencies/LiquityMath.sol";
import "../Interfaces/ITHUSDToken.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "../Interfaces/ITroveManager.sol";
import "../Interfaces/IStabilityPool.sol";
import "../Interfaces/IPriceFeed.sol";
import "../Interfaces/IPCV.sol";
import "./BorrowerOperationsScript.sol";
import "./ETHTransferScript.sol";
import "./ERC20TransferScript.sol";
import "./PCVScript.sol";
import "../Dependencies/console.sol";

contract BorrowerWrappersScript is BorrowerOperationsScript, ETHTransferScript, ERC20TransferScript, PCVScript {

    string constant public NAME = "BorrowerWrappersScript";

    ITroveManager immutable troveManager;
    IStabilityPool immutable stabilityPool;
    IPriceFeed immutable priceFeed;
    ITHUSDToken immutable thusdToken;
    IPCV immutable pcv;

    constructor(
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _pcvAddress
    )
        BorrowerOperationsScript(IBorrowerOperations(_borrowerOperationsAddress))
        PCVScript(_pcvAddress)
    {
        checkContract(_troveManagerAddress);
        ITroveManager troveManagerCached = ITroveManager(_troveManagerAddress);
        troveManager = troveManagerCached;

        IStabilityPool stabilityPoolCached = troveManagerCached.stabilityPool();
        checkContract(address(stabilityPoolCached));
        stabilityPool = stabilityPoolCached;

        IPriceFeed priceFeedCached = troveManagerCached.priceFeed();
        checkContract(address(priceFeedCached));
        priceFeed = priceFeedCached;

        address thusdTokenCached = address(troveManagerCached.thusdToken());
        checkContract(thusdTokenCached);
        thusdToken = ITHUSDToken(thusdTokenCached);

        IPCV pcvCached = troveManagerCached.pcv();
        require(_pcvAddress == address(pcvCached), "BorrowerWrappersScript: Wrong PCV address");
        pcv = pcvCached;
    }

    function claimCollateralAndOpenTrove(uint256 _maxFee, uint256 _THUSDAmount, address _upperHint, address _lowerHint) external payable {
        uint256 balanceBefore = address(this).balance;

        // Claim collateral
        borrowerOperations.claimCollateral();

        uint256 balanceAfter = address(this).balance;

        // already checked in CollSurplusPool
        assert(balanceAfter > balanceBefore);

        uint256 totalCollateral = balanceAfter - balanceBefore + msg.value;

        // Open trove with obtained collateral, plus collateral sent by user
        // if (borrowerOperations.collateralAddress() == address(0)) {
        //   borrowerOperations.openTrove{ value: totalCollateral }(_maxFee, _THUSDAmount, 0, _upperHint, _lowerHint);
        // } else {
          borrowerOperations.openTrove{ value: 0 }(_maxFee, _THUSDAmount, totalCollateral, _upperHint, _lowerHint);
        // }
    }

    function claimSPRewardsAndRecycle(uint256 _maxFee, address _upperHint, address _lowerHint) external {
        uint256 collBalanceBefore = address(this).balance;

        // Claim rewards
        stabilityPool.withdrawFromSP(0);

        uint256 collBalanceAfter = address(this).balance;
        uint256 claimedCollateral = collBalanceAfter - collBalanceBefore;

        // Add claimed collateral to trove, get more THUSD and stake it into the Stability Pool
        if (claimedCollateral > 0) {
            _requireUserHasTrove(address(this));
            uint256 THUSDAmount = _getNetTHUSDAmount(claimedCollateral);
            // if (borrowerOperations.collateralAddress() == address(0)) {
            //   borrowerOperations.adjustTrove{ value: claimedCollateral }(_maxFee, 0, THUSDAmount, true, 0, _upperHint, _lowerHint);
            // } else {
              borrowerOperations.adjustTrove{ value: 0 }(_maxFee, 0, THUSDAmount, true, claimedCollateral, _upperHint, _lowerHint);
            // }
            // Provide withdrawn THUSD to Stability Pool
            if (THUSDAmount > 0) {
                thusdToken.increaseAllowance(address(stabilityPool), THUSDAmount);
                stabilityPool.provideToSP(THUSDAmount);
            }
        }
    }

    function claimStakingGainsAndRecycle(uint256 _maxFee, address _upperHint, address _lowerHint) external {
        uint256 collBalanceBefore = address(this).balance;
        uint256 thusdBalanceBefore = thusdToken.balanceOf(address(this));

        uint256 gainedCollateral = address(this).balance - collBalanceBefore; // stack too deep issues :'(
        uint256 gainedTHUSD = thusdToken.balanceOf(address(this)) - thusdBalanceBefore;

        uint256 netTHUSDAmount;
        // Top up trove and get more THUSD, keeping ICR constant
        if (gainedCollateral > 0) {
            _requireUserHasTrove(address(this));
            netTHUSDAmount = _getNetTHUSDAmount(gainedCollateral);
            // if (borrowerOperations.collateralAddress() == address(0)) {
            //   borrowerOperations.adjustTrove{ value: gainedCollateral }(_maxFee, 0, netTHUSDAmount, true, 0, _upperHint, _lowerHint);
            // } else {
              borrowerOperations.adjustTrove{ value: 0 }(_maxFee, 0, netTHUSDAmount, true, gainedCollateral, _upperHint, _lowerHint);
            // }
        }

        uint256 totalTHUSD = gainedTHUSD + netTHUSDAmount;
        if (totalTHUSD > 0) {
            thusdToken.approve(address(stabilityPool), totalTHUSD);
            stabilityPool.provideToSP(totalTHUSD);
        }

    }

    function _getNetTHUSDAmount(uint256 _collateral) internal returns (uint) {
        uint256 price = priceFeed.fetchPrice();
        uint256 ICR = troveManager.getCurrentICR(address(this), price);

        uint256 THUSDAmount = _collateral * price / ICR;
        uint256 borrowingRate = troveManager.getBorrowingRateWithDecay();
        uint256 netDebt = THUSDAmount * LiquityMath.DECIMAL_PRECISION / (LiquityMath.DECIMAL_PRECISION + borrowingRate);

        return netDebt;
    }

    function _requireUserHasTrove(address _depositor) internal view {
        require(
            troveManager.getTroveStatus(_depositor) == ITroveManager.Status.active, 
            "BorrowerWrappersScript: caller must have an active trove"
        );
    }
}
