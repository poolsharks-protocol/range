import { store } from "@graphprotocol/graph-ts"
import { Burn, BurnFungible } from "../../../generated/RangePoolFactory/RangePool"
import { safeLoadBasePrice, safeLoadPosition, safeLoadPositionById, safeLoadPositionFraction, safeLoadPositionToken, safeLoadRangePool, safeLoadRangePoolFactory, safeLoadTick, safeLoadToken } from "../utils/loads"
import {
    BigInt,
    Bytes,
} from '@graphprotocol/graph-ts'
import { ONE_BI } from "../../constants/constants"
import { updateDerivedTVLAmounts } from "../utils/tvl"
import { BIGDECIMAL_ZERO, BIGINT_ZERO, convertTokenToDecimal } from "../utils/helpers"
import { Position } from "../../../generated/schema"

export function handleBurn(event: Burn): void {
    let recipientParam = event.params.recipient.toHex()
    let lowerParam = event.params.lower
    let upperParam = event.params.upper 
    let liquidityBurnedParam = event.params.liquidityBurned
    let amount0Param = event.params.amount0
    let amoun1Param = event.params.amount1
    let collectParam = event.params.collect
    let ownerParam = event.params.owner.toHex()
    let poolAddress = event.address.toHex()
    let msgSender = event.transaction.from

    let lower = BigInt.fromI32(lowerParam)
    let upper = BigInt.fromI32(upperParam)

    let loadBasePrice = safeLoadBasePrice('eth')
    let loadRangePool = safeLoadRangePool(poolAddress)
    let basePrice = loadBasePrice.entity
    let pool = loadRangePool.entity

    let loadRangePoolFactory = safeLoadRangePoolFactory(pool.factory)
    let loadToken0 = safeLoadToken(pool.token0)
    let loadToken1 = safeLoadToken(pool.token1)
    let factory = loadRangePoolFactory.entity
    let token0 = loadToken0.entity
    let token1 = loadToken1.entity

    let loadLowerTick = safeLoadTick(
        poolAddress,
        lower
    )
    let loadUpperTick = safeLoadTick(
        poolAddress,
        upper
    )
    let loadPosition = safeLoadPosition(
        poolAddress,
        ownerParam,
        lower,
        upper
    )
    let position = loadPosition.entity
    let lowerTick = loadLowerTick.entity
    let upperTick = loadUpperTick.entity

    // convert amounts to decimal values
    let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
    let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)
    let amountUsd = amount0
        .times(token0.ethPrice.times(basePrice.ethUsd))
        .plus(amount1.times(token1.ethPrice.times(basePrice.ethUsd)))

    if (!loadPosition.exists) {
        //something is wrong
    } else if (collectParam) {
        if(position.liquidity.equals(liquidityBurnedParam)) {
            store.remove('Position', poolAddress
                                     .concat(ownerParam)
                                     .concat(lower.toString())
                                     .concat(upper.toString()))
        } else {
            position.amount0 = BIGDECIMAL_ZERO
            position.amount1 = BIGDECIMAL_ZERO
        }
    } else {
        position.amount0 = position.amount0.plus(amount0)
        position.amount1 = position.amount1.plus(amount1)
        position.liquidity = position.liquidity.minus(liquidityBurnedParam)
        position.updatedAtBlockNumber = event.block.number
        position.updatedAtTimestamp = event.block.timestamp
        position.save()
    }

    lowerTick.liquidityDelta = lowerTick.liquidityDelta.minus(liquidityBurnedParam)
    upperTick.liquidityDelta = upperTick.liquidityDelta.plus(liquidityBurnedParam)
    upperTick.liquidityDeltaMinus = upperTick.liquidityDeltaMinus.minus(liquidityBurnedParam)
    
    // remove from store to sync up with pool
    if(lowerTick.liquidityDelta.equals(BIGINT_ZERO) && lowerTick.liquidityDeltaMinus.equals(BIGINT_ZERO)) {
        store.remove('Tick', poolAddress.concat(lower.toString()))
    } else {
        lowerTick.save()
    }
    if(upperTick.liquidityDelta.equals(BIGINT_ZERO) && upperTick.liquidityDeltaMinus.equals(BIGINT_ZERO)) {
        store.remove('Tick', poolAddress.concat(upper.toString()))
    } else {
        upperTick.save()
    }

    token0.txnCount = token0.txnCount.plus(ONE_BI)
    token1.txnCount = token1.txnCount.plus(ONE_BI)
    pool.txnCount = pool.txnCount.plus(ONE_BI)
    factory.txnCount = factory.txnCount.plus(ONE_BI)

    // tvl updates
    let oldPoolTotalValueLockedEth = pool.totalValueLockedEth
    token0.totalValueLocked = token0.totalValueLocked.minus(amount0)
    token1.totalValueLocked = token1.totalValueLocked.minus(amount1)
    pool.totalValueLocked0 = pool.totalValueLocked0.minus(amount0)
    pool.totalValueLocked1 = pool.totalValueLocked1.minus(amount1)
    updateDerivedTVLAmounts(pool, factory, oldPoolTotalValueLockedEth)

    if (
        pool.nearestTick !== null &&
        lower.le(pool.nearestTick) &&
        upper.gt(pool.nearestTick)
      ) {
        pool.liquidity = pool.liquidity.minus(liquidityBurnedParam)
    }
    
    token0.save()
    token1.save()
    pool.save()
    factory.save()
}

export function handleBurnFungible(event: BurnFungible): void {
    let recipientParam = event.params.recipient.toHex()
    let tokenParam = event.params.token.toHex()
    let tokenBurnedParam = event.params.tokenBurned
    let liquidityBurnedParam = event.params.liquidityBurned
    let amount0Param = event.params.amount0
    let amoun1Param = event.params.amount1
    let poolAddress = event.address.toHex()
    let msgSender = event.transaction.from.toHex()

    let loadPositionToken = safeLoadPositionToken(tokenParam)
    let positionToken = loadPositionToken.entity
    //TODO: handle positionToken transfers
    let loadPositionFraction = safeLoadPositionFraction(tokenParam, msgSender)
    let positionFraction = loadPositionFraction.entity
    let loadPosition = safeLoadPositionById(positionToken.position)
    let position = loadPosition.entity

    let lower = position.lower
    let upper = position.upper

    let loadBasePrice = safeLoadBasePrice('eth')
    let loadRangePool = safeLoadRangePool(poolAddress)
    let basePrice = loadBasePrice.entity
    let pool = loadRangePool.entity

    let loadRangePoolFactory = safeLoadRangePoolFactory(pool.factory)
    let loadToken0 = safeLoadToken(pool.token0)
    let loadToken1 = safeLoadToken(pool.token1)
    let factory = loadRangePoolFactory.entity
    let token0 = loadToken0.entity
    let token1 = loadToken1.entity

    let loadLowerTick = safeLoadTick(
        poolAddress,
        lower
    )
    let loadUpperTick = safeLoadTick(
        poolAddress,
        upper
    )
    let lowerTick = loadLowerTick.entity
    let upperTick = loadUpperTick.entity

    // convert amounts to decimal values
    let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
    let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)
    let amountUsd = amount0
        .times(token0.ethPrice.times(basePrice.ethUsd))
        .plus(amount1.times(token1.ethPrice.times(basePrice.ethUsd)))

    if (positionFraction.amount.equals(tokenBurnedParam)) {
        let positionTokenFractions = positionToken.fractions
        let fractionIndex = positionTokenFractions.indexOf(positionFraction.id)
        positionTokenFractions.splice(fractionIndex, 1)
        positionToken.fractions = positionTokenFractions
        store.remove('PositionFraction', tokenParam.concat(msgSender))
    } else {
        positionFraction.amount = positionFraction.amount.minus(tokenBurnedParam)
        positionFraction.updatedAtBlockNumber = event.block.number
        positionFraction.updatedAtTimestamp = event.block.timestamp
        positionFraction.save()
    }

    if (position.liquidity.equals(liquidityBurnedParam)) {
        store.remove('Position', poolAddress
                                    .concat(poolAddress)
                                    .concat(lower.toString())
                                    .concat(upper.toString()))
    } else {
        position.liquidity = position.liquidity.minus(liquidityBurnedParam)
        position.updatedAtBlockNumber = event.block.number
        position.updatedAtTimestamp = event.block.timestamp
        position.save()
    }
    if (positionToken.totalSupply.equals(tokenBurnedParam)) {
        store.remove('PositionToken', tokenParam)
    } else {
        positionToken.totalSupply = positionToken.totalSupply.minus(tokenBurnedParam)
        positionToken.save()
    }

    lowerTick.liquidityDelta = lowerTick.liquidityDelta.minus(liquidityBurnedParam)
    upperTick.liquidityDelta = upperTick.liquidityDelta.plus(liquidityBurnedParam)
    upperTick.liquidityDeltaMinus = upperTick.liquidityDeltaMinus.minus(liquidityBurnedParam)
    
    // remove from store to sync up with pool
    if(lowerTick.liquidityDelta.equals(BIGINT_ZERO) && lowerTick.liquidityDeltaMinus.equals(BIGINT_ZERO)) {
        store.remove('Tick', poolAddress.concat(lower.toString()))
    } else {
        lowerTick.save()
    }
    if(upperTick.liquidityDelta.equals(BIGINT_ZERO) && upperTick.liquidityDeltaMinus.equals(BIGINT_ZERO)) {
        store.remove('Tick', poolAddress.concat(upper.toString()))
    } else {
        upperTick.save()
    }

    token0.txnCount = token0.txnCount.plus(ONE_BI)
    token1.txnCount = token1.txnCount.plus(ONE_BI)
    pool.txnCount = pool.txnCount.plus(ONE_BI)
    factory.txnCount = factory.txnCount.plus(ONE_BI)

    // tvl updates
    let oldPoolTotalValueLockedEth = pool.totalValueLockedEth
    token0.totalValueLocked = token0.totalValueLocked.minus(amount0)
    token1.totalValueLocked = token1.totalValueLocked.minus(amount1)
    pool.totalValueLocked0 = pool.totalValueLocked0.minus(amount0)
    pool.totalValueLocked1 = pool.totalValueLocked1.minus(amount1)
    updateDerivedTVLAmounts(pool, factory, oldPoolTotalValueLockedEth)

    if (
        pool.nearestTick !== null &&
        lower.le(pool.nearestTick) &&
        upper.gt(pool.nearestTick)
      ) {
        pool.liquidity = pool.liquidity.minus(liquidityBurnedParam)
    }
    
    token0.save()
    token1.save()
    pool.save()
    factory.save()
}