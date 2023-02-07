// SPDX-License-Identifier: GPLv3
pragma solidity ^0.8.13;

import './interfaces/IRangePool.sol';
import './interfaces/IRangePool.sol';
import './base/RangePoolStorage.sol';
import './base/RangePoolEvents.sol';
import './utils/SafeTransfers.sol';
import './utils/RangePoolErrors.sol';
import './libraries/Ticks.sol';
import './libraries/Positions.sol';
import "./RangePoolERC20.sol";

contract RangePool is IRangePool, RangePoolStorage, RangePoolEvents, SafeTransfers {
    uint16 internal constant MAX_FEE = 10000;
    address internal immutable factory;
    address internal immutable token0;
    address internal immutable token1;

    modifier lock() {
        if (poolState.unlocked != 1) revert Locked();
        poolState.unlocked = 2;
        _;
        poolState.unlocked = 1;
    }

    constructor(
        address _token0,
        address _token1,
        int24 _tickSpacing,
        uint16 _swapFee,
        uint160 _startPrice
    ) {
        // validate swap fee
        if (_swapFee > MAX_FEE) revert InvalidSwapFee();

        // set addresses
        factory = msg.sender;
        token0 = _token0;
        token1 = _token1;
        feeTo = IRangePoolFactory(msg.sender).owner();

        // set global state
        PoolState memory pool = PoolState(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        pool.swapFee = _swapFee;
        pool.tickSpacing = _tickSpacing;
        pool.price = _startPrice;
        pool.unlocked = 1;

        // create min and max ticks
        Ticks.initialize(ticks);
    }

    //TODO: add ERC-721 interface
    //TODO: add documentation here to note params
    function mint(
        MintParams calldata mintParams
    ) external lock {
        PoolState memory pool = poolState;
        MintParams memory params = mintParams;
        uint256 liquidityMinted;
        (params, liquidityMinted) = Positions.validate(params, pool);
        _transferIn(token0, params.amount0);
        _transferIn(token1, params.amount1);

        //TODO: is this dangerous?
        unchecked {
            //TODO: if fees > 0 emit PositionUpdated event
            // update position with latest fees accrued
            (positions[params.fungible ? address(this) : params.to][params.lower][params.upper], , ) = Positions.update(
                ticks,
                positions,
                pool,
                params.to,
                params.lower,
                params.upper
            );
            pool = Positions.add(
                positions,
                ticks,
                pool,
                params,
                uint128(liquidityMinted)
            );
        }

        if (params.fungible) {
            address positionToken = tokens[params.lower][params.upper];
            if (positionToken == address(0)) {
                positionToken = address(new RangePoolERC20());
            } 
        }

        emit Mint(params.to, params.lower, params.upper, uint128(liquidityMinted));
    }

    function burn(
        int24 lower,
        int24 upper,
        uint128 amount
    ) external lock {
        PoolState memory pool = poolState;
        // Ensure no overflow happens when we cast from uint128 to int128.
        if (amount > uint128(type(int128).max)) revert LiquidityOverflow();
        // update position and get new lower and upper
        uint128 amount0;
        uint128 amount1;
        (positions[msg.sender][lower][upper], amount0, amount1) = Positions.update(
            ticks,
            positions,
            pool,
            msg.sender,
            lower,
            upper
        );
        //TODO: add PositionUpdated event
        (pool, amount0, amount1) = Positions.remove(
            positions,
            ticks,
            pool,
            RemoveParams(msg.sender, lower, upper, amount, amount0, amount1)
        );
        emit Burn(msg.sender, lower, upper, amount);
        poolState = pool;
    }

    function collect(int24 lower, int24 upper)
        public
        lock
        returns (uint256 amount0, uint256 amount1)
    {
        (positions[msg.sender][lower][upper], , ) = Positions.update(
            ticks,
            positions,
            poolState,
            msg.sender,
            lower,
            upper
        );
        amount0 = positions[msg.sender][lower][upper].amount0;
        amount1 = positions[msg.sender][lower][upper].amount1;
        /// zero out balances
        positions[msg.sender][lower][upper].amount0 = 0;
        positions[msg.sender][lower][upper].amount1 = 0;
        /// transfer out balances
        _transferOut(msg.sender, token0, amount0);
        _transferOut(msg.sender, token1, amount1);

        emit Collect(msg.sender, amount0, amount1);
    }

    //TODO: block the swap if there is an overflow on fee growth
    function swap(
        address recipient,
        bool zeroForOne,
        uint256 amountIn,
        uint160 priceLimit
    )
        external
        override
        // bytes calldata data
        lock
        returns (uint256, uint256)
    {
        PoolState memory pool = poolState;
        TickMath.validatePrice(priceLimit);
        if (amountIn == 0) return (0, 0);
        _transferIn(zeroForOne ? token0 : token1, amountIn);

        SwapCache memory cache = SwapCache({
            input: amountIn,
            output: 0,
            feeAmount: PrecisionMath.mulDivRoundingUp(amountIn, pool.swapFee, 1e6)
        });
        // take fee from input amount
        cache.input -= cache.feeAmount;

        while (pool.price != priceLimit && cache.input != 0) {
            (pool, cache) = Ticks.quote(ticks, zeroForOne, priceLimit, pool, cache);
        }
        // handle fee return and transfer out
        if (zeroForOne) {
            if (cache.input > 0) {
                uint128 feeReturn = uint128(
                    (((cache.input * 1e18) / (amountIn - cache.feeAmount)) * cache.feeAmount) / 1e18
                );
                cache.feeAmount -= feeReturn;
                pool.feeGrowthGlobal0 += uint128(cache.feeAmount);
                _transferOut(recipient, token0, cache.input + feeReturn);
            }
            _transferOut(recipient, token1, cache.output);
            emit Swap(recipient, token0, token1, amountIn - cache.input, cache.output);
        } else {
            if (cache.input > 0) {
                uint128 feeReturn = uint128(
                    (((cache.input * 1e18) / (amountIn - cache.feeAmount)) * cache.feeAmount) / 1e18
                );
                cache.feeAmount -= feeReturn;
                pool.feeGrowthGlobal1 += uint128(cache.feeAmount);
                _transferOut(recipient, token1, cache.input + feeReturn);
            }
            _transferOut(recipient, token0, cache.output);
            emit Swap(recipient, token1, token0, amountIn - cache.input, cache.output);
        }
        poolState = pool;
        return (amountIn - cache.input, cache.output);
    }

    function quote(
        bool zeroForOne,
        uint256 amountIn,
        uint160 priceLimit
    ) external view override returns (uint256 inAmount, uint256 outAmount) {
        PoolState memory pool = poolState;
        SwapCache memory cache = SwapCache({
            input: amountIn,
            output: 0,
            feeAmount: PrecisionMath.mulDivRoundingUp(amountIn, pool.swapFee, 1e6)
        });
        // take fee from inputAmount
        cache.input -= cache.feeAmount;

        while (pool.price != priceLimit && cache.input != 0) {
            (pool, cache) = Ticks.quote(ticks, zeroForOne, priceLimit, pool, cache);
        }
        if (zeroForOne) {
            if (cache.input > 0) {
                uint128 feeReturn = uint128(
                    (((cache.input * 1e18) / (amountIn - cache.feeAmount)) * cache.feeAmount) / 1e18
                );
                cache.input += feeReturn;
            }
        } else {
            if (cache.input > 0) {
                uint128 feeReturn = uint128(
                    (((cache.input * 1e18) / (amountIn - cache.feeAmount)) * cache.feeAmount) / 1e18
                );
                cache.input += feeReturn;
            }
        }
        inAmount = amountIn - cache.input;
        outAmount = cache.output;
    }
}
