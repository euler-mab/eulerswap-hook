// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "openzeppelin-contracts/interfaces/IERC20.sol";
import "openzeppelin-contracts/utils/Address.sol";

/**
 * @title Propellerheads Safe ERC20 Transfer Library
 * @author PropellerHeads Developers
 * @dev Gas-efficient version of Openzeppelin's SafeERC20 contract.
 * This is a mix between SafeERC20 and GPv2SafeERC20 libraries. It
 * provides efficient transfers optimised for router contracts, while
 * keeping the Openzeppelins compatibility for approvals.
 */
library EfficientERC20 {
    using Address for address;

    error TransferFailed(uint256 balance, uint256 amount);
    error TransferFromFailed(uint256 balance, uint256 amount);

    bytes4 private constant _balanceOfSelector = hex"70a08231";
    bytes4 private constant _transferSelector = hex"a9059cbb";

    /// @dev Wrapper around a call to the ERC20 function `transfer` that reverts
    /// also when the token returns `false`.
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let freeMemoryPointer := mload(0x40)
            mstore(freeMemoryPointer, _transferSelector)
            mstore(
                add(freeMemoryPointer, 4),
                and(to, 0xffffffffffffffffffffffffffffffffffffffff)
            )
            mstore(add(freeMemoryPointer, 36), value)

            if iszero(call(gas(), token, 0, freeMemoryPointer, 68, 0, 0)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }

        if (!getLastTransferResult(token)) {
            uint256 balance = token.balanceOf(address(this));
            revert TransferFailed(balance, value);
        }
    }

    /**
     * @dev Transfers the callers balance - 1. This effectively leaves dust on
     * the contract
     *     which will lead to more gas efficient transfers in the future.
     */
    function transferBalanceLeavingDust(IERC20 token, address to) internal {
        uint256 amount;
        assembly {
            let input := mload(0x40)
            mstore(input, _balanceOfSelector)
            mstore(add(input, 0x04), address())

            let success := staticcall(gas(), token, input, 0x24, input, 0x20)

            if iszero(success) {
                let returnSize := returndatasize()
                returndatacopy(input, 0, returnSize)
                revert(input, returnSize)
            }

            amount := sub(mload(input), 1)

            mstore(input, _transferSelector)
            mstore(add(input, 0x04), to)
            mstore(add(input, 0x24), amount)

            if iszero(call(gas(), token, 0, input, 0x44, 0, 0)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }

        if (!getLastTransferResult(token)) {
            uint256 balance = token.balanceOf(address(this));
            revert TransferFailed(balance, amount);
        }
    }

    /**
     * @dev Wrapper around a call to the ERC20 function `transferFrom` that
     *  reverts also when the token returns `false`.
     */
    function safeTransferFrom(
        IERC20 token,
        address from,
        address to,
        uint256 value
    ) internal {
        bytes4 selector_ = token.transferFrom.selector;

        // solhint-disable-next-line no-inline-assembly
        assembly {
            let freeMemoryPointer := mload(0x40)
            mstore(freeMemoryPointer, selector_)
            mstore(
                add(freeMemoryPointer, 4),
                and(from, 0xffffffffffffffffffffffffffffffffffffffff)
            )
            mstore(
                add(freeMemoryPointer, 36),
                and(to, 0xffffffffffffffffffffffffffffffffffffffff)
            )
            mstore(add(freeMemoryPointer, 68), value)

            if iszero(call(gas(), token, 0, freeMemoryPointer, 100, 0, 0)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }

        if (!getLastTransferResult(token)) {
            uint256 balance = token.balanceOf(address(this));
            revert TransferFailed(balance, value);
        }
    }

    /**
     * @dev Deprecated. This function has issues similar to the ones found in
     * {IERC20-approve}, and its usage is discouraged.
     */
    function safeApprove(IERC20 token, address spender, uint256 value)
        internal
    {
        require(
            (value == 0) || (token.allowance(address(this), spender) == 0),
            "SafeERC20: approve from non-zero to non-zero allowance"
        );
        _callOptionalReturn(
            token,
            abi.encodeWithSelector(token.approve.selector, spender, value)
        );
    }

    /**
     * @dev Set the calling contract's allowance toward `spender` to `value`. If
     * `token` returns no value,
     * non-reverting calls are assumed to be successful. Meant to be used with
     * tokens that require the approval
     * to be set to zero before setting it to a non-zero value, such as USDT.
     */
    function forceApprove(IERC20 token, address spender, uint256 value)
        internal
    {
        bytes memory approvalCall =
            abi.encodeCall(token.approve, (spender, value));

        if (!_callOptionalReturnBool(token, approvalCall)) {
            _callOptionalReturn(
                token, abi.encodeCall(token.approve, (spender, 0))
            );
            _callOptionalReturn(token, approvalCall);
        }
    }

    function _callOptionalReturn(IERC20 token, bytes memory data) private {
        bytes memory returndata = address(token).functionCall(data);
        if (returndata.length > 0) {
            require(
                abi.decode(returndata, (bool)),
                "SafeERC20: ERC20 operation did not succeed"
            );
        }
    }

    function _callOptionalReturnBool(IERC20 token, bytes memory data)
        private
        returns (bool)
    {
        (bool success, bytes memory returndata) = address(token).call(data);
        return success
            && (returndata.length == 0 || abi.decode(returndata, (bool)))
            && address(token).code.length > 0;
    }

    /// @dev Verifies that the last return was a successful `transfer*` call.
    function getLastTransferResult(IERC20 token)
        private
        view
        returns (bool success)
    {
        assembly {
            function revertWithMessage(length, message) {
                mstore(0x00, "\x08\xc3\x79\xa0")
                mstore(0x04, 0x20)
                mstore(0x24, length)
                mstore(0x44, message)
                revert(0x00, 0x64)
            }

            switch returndatasize()
            case 0 {
                if iszero(extcodesize(token)) {
                    revertWithMessage(20, "GPv2: not a contract")
                }
                success := 1
            }
            case 32 {
                returndatacopy(0, 0, returndatasize())
                success := iszero(iszero(mload(0)))
            }
            default {
                revertWithMessage(31, "GPv2: malformed transfer result")
            }
        }
    }
}
