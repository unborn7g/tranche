// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMezoRouter} from "../Tranche.sol";

contract MockToken is ERC20 {
    uint8 private immutable precision;

    constructor(string memory tokenSymbol, uint8 decimals_) ERC20(tokenSymbol, tokenSymbol) {
        precision = decimals_;
    }

    function decimals() public view override returns (uint8) { return precision; }

    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockRouter is IMezoRouter {
    uint256 public bps = 9_950;

    function setRate(uint256 bps_) external { bps = bps_; }

    function getAmountsOut(uint256 amountIn, Route[] calldata) public view returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn * bps / 10_000 / 1e12;
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256 minimum, Route[] calldata routes, address to, uint256 deadline)
        external returns (uint256[] memory amounts)
    {
        amounts = getAmountsOut(amountIn, routes);
        require(routes[0].stable && routes[0].factory != address(0), "wrong route");
        require(block.timestamp <= deadline && amounts[1] >= minimum, "quote expired or too low");
        require(IERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn), "input transfer");
        MockToken(routes[0].to).mint(to, amounts[1]);
    }
}
