// SPDX-License-Identifier: MIT

pragma solidity 0.8.9;

import { IERC20 } from '../interfaces/IERC20.sol';

contract TokenSwapper {
    address tokenA;
    address tokenB;

    constructor(address tokenA_, address tokenB_) {
        tokenA = tokenA_;
        tokenB = tokenB_;
    }

    function swap(
        address tokenAddress,
        uint256 amount,
        address toTokenAddress,
        address recipient
    ) external returns (uint256 convertedAmount) {
        IERC20(tokenAddress).transferFrom(msg.sender, address(this), amount);

        uint256 balanceTokenB; 

        if (tokenAddress == tokenA) {
            require(toTokenAddress == tokenB, 'WRONG TOKEN PAIR');
            convertedAmount = amount * 2;
            balanceTokenB = IERC20(toTokenAddress).balanceOf(address(this));
        } else {
            require(tokenAddress == tokenB && toTokenAddress == tokenA, 'WRONG TOKEN PAIR');
            convertedAmount = amount / 2;
            balanceTokenB = IERC20(tokenAddress).balanceOf(address(this));

        }

        require(balanceTokenB >= convertedAmount, "Not enough of tokenB");

        IERC20(toTokenAddress).transfer(recipient, convertedAmount);
    }
}
