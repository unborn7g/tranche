// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMezoRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory);
}

/// @notice Milestone escrow for standard, non-rebasing MUSD and mUSDC tokens.
/// @dev The reviewer is trusted to assess the work and resolve disputed items.
contract Tranche is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { Pending, Approved, Disputed, Paid, Refunded }
    enum Decision { Approve, Dispute, Refund }

    struct Milestone {
        address owner;
        address reviewer;
        string title;
        uint256 budget;
        uint256 held;
        bool funded;
    }

    struct LineInput {
        string label;
        address recipient;
        uint256 budget;
    }

    struct Line {
        string label;
        address recipient;
        uint256 budget;
        uint256 revision;
        Status status;
        bytes32 evidenceHash;
        uint256 minMusdc;
        uint256 amountPaid;
    }

    struct Review {
        uint256 milestoneId;
        uint256 lineIndex;
        Decision decision;
        bytes32 evidenceHash;
        uint256 revision;
        uint256 deadline;
    }

    struct Payment {
        uint256 lineIndex;
        uint256 extraMusd;
        uint256 minOut;
    }

    bytes32 private constant REVIEW_TYPEHASH = keccak256(
        "Review(uint256 milestoneId,uint256 lineIndex,uint8 decision,bytes32 evidenceHash,uint256 revision,uint256 deadline)"
    );

    IERC20 public immutable musd;
    IERC20 public immutable musdc;
    IMezoRouter public immutable router;
    address public immutable factory;
    uint256 public nextId = 1;

    mapping(uint256 => Milestone) private milestones;
    mapping(uint256 => Line[]) private milestoneLines;

    error InvalidConfiguration();
    error InvalidMilestone();
    error InvalidLine();
    error InvalidState();
    error Unauthorized();
    error InvalidCertificate();
    error Expired();
    error InsufficientPayout(uint256 received, uint256 minimum);

    event MilestoneCreated(uint256 indexed id, address indexed owner, address indexed reviewer, uint256 budget);
    event Funded(uint256 indexed id, uint256 amount);
    event Reviewed(uint256 indexed id, uint256 indexed lineIndex, Decision decision, bytes32 evidenceHash);
    event PayoutSelected(uint256 indexed id, uint256 indexed lineIndex, uint256 minMusdc);
    event Paid(uint256 indexed id, uint256 indexed lineIndex, address indexed recipient, address token, uint256 amount, uint256 extraMusd);
    event Refunded(uint256 indexed id, uint256 indexed lineIndex, uint256 amount);

    constructor(address musd_, address musdc_, address router_, address factory_) EIP712("Tranche", "1") {
        if (musd_ == musdc_ || musd_.code.length == 0 || musdc_.code.length == 0 || router_.code.length == 0 || factory_ == address(0)) {
            revert InvalidConfiguration();
        }
        musd = IERC20(musd_);
        musdc = IERC20(musdc_);
        router = IMezoRouter(router_);
        factory = factory_;
    }

    function createMilestone(string calldata title, address reviewer, LineInput[] calldata lines) external returns (uint256 id) {
        if (bytes(title).length == 0 || bytes(title).length > 120 || reviewer == address(0) || reviewer == msg.sender || lines.length == 0 || lines.length > 12) {
            revert InvalidMilestone();
        }
        id = nextId++;
        uint256 budget;
        for (uint256 i; i < lines.length; ++i) {
            LineInput calldata line = lines[i];
            if (line.recipient == address(0) || line.recipient == reviewer || line.recipient == address(this) || line.budget == 0 || bytes(line.label).length == 0 || bytes(line.label).length > 120) {
                revert InvalidLine();
            }
            milestoneLines[id].push(Line(line.label, line.recipient, line.budget, 0, Status.Pending, bytes32(0), 0, 0));
            budget += line.budget;
        }
        milestones[id] = Milestone(msg.sender, reviewer, title, budget, 0, false);
        emit MilestoneCreated(id, msg.sender, reviewer, budget);
    }

    function getMilestone(uint256 id) external view returns (Milestone memory, Line[] memory) {
        if (milestones[id].owner == address(0)) revert InvalidMilestone();
        return (milestones[id], milestoneLines[id]);
    }

    function fund(uint256 id) external nonReentrant {
        Milestone storage milestone = milestones[id];
        if (msg.sender != milestone.owner) revert Unauthorized();
        if (milestone.funded) revert InvalidState();
        milestone.funded = true;
        milestone.held = milestone.budget;
        musd.safeTransferFrom(msg.sender, address(this), milestone.budget);
        emit Funded(id, milestone.budget);
    }

    /// @notice Submits a batch of EIP-712 certificates from the assigned reviewer.
    /// @dev Any address can relay the certificates. Revisions prevent replay.
    function applyReviews(Review[] calldata reviews, bytes[] calldata signatures) external nonReentrant {
        if (reviews.length == 0 || reviews.length > 12 || reviews.length != signatures.length) revert InvalidCertificate();
        for (uint256 i; i < reviews.length; ++i) {
            _applyReview(reviews[i], signatures[i]);
        }
    }

    function _applyReview(Review calldata review, bytes calldata signature) private {
        if (block.timestamp > review.deadline) revert Expired();
        Milestone storage milestone = milestones[review.milestoneId];
        Line storage line = _line(review.milestoneId, review.lineIndex);
        if (!milestone.funded || line.status == Status.Paid || line.status == Status.Refunded) revert InvalidState();
        if (review.revision != line.revision + 1 || review.evidenceHash == bytes32(0)) revert InvalidCertificate();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            REVIEW_TYPEHASH, review.milestoneId, review.lineIndex, review.decision,
            review.evidenceHash, review.revision, review.deadline
        )));
        if (!SignatureChecker.isValidSignatureNow(milestone.reviewer, digest, signature)) revert InvalidCertificate();
        line.revision = review.revision;
        line.evidenceHash = review.evidenceHash;
        emit Reviewed(review.milestoneId, review.lineIndex, review.decision, review.evidenceHash);
        if (review.decision == Decision.Refund) {
            if (line.status != Status.Disputed) revert InvalidState();
            line.status = Status.Refunded;
            milestone.held -= line.budget;
            musd.safeTransfer(milestone.owner, line.budget);
            emit Refunded(review.milestoneId, review.lineIndex, line.budget);
        } else {
            line.status = review.decision == Decision.Approve ? Status.Approved : Status.Disputed;
        }
    }

    /// @notice Only the payee can opt into mUSDC. A zero minimum selects MUSD.
    function setPayout(uint256 id, uint256 lineIndex, uint256 minMusdc) external {
        Line storage line = _line(id, lineIndex);
        if (msg.sender != line.recipient) revert Unauthorized();
        if (line.status == Status.Paid || line.status == Status.Refunded) revert InvalidState();
        line.minMusdc = minMusdc;
        emit PayoutSelected(id, lineIndex, minMusdc);
    }

    function quoteMusdc(uint256 amountIn) external view returns (uint256) {
        uint256[] memory amounts = router.getAmountsOut(amountIn, _route());
        return amounts[1];
    }

    /// @notice Pay approved items atomically. The owner can fund a conversion shortfall separately.
    function settle(uint256 id, Payment[] calldata payments, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        Milestone storage milestone = milestones[id];
        if (msg.sender != milestone.owner) revert Unauthorized();
        if (!milestone.funded || payments.length == 0 || payments.length > milestoneLines[id].length) revert InvalidState();
        for (uint256 i; i < payments.length; ++i) {
            _settleLine(id, milestone, payments[i], deadline);
        }
    }

    function _settleLine(uint256 id, Milestone storage milestone, Payment calldata payment, uint256 deadline) private {
        Line storage line = _line(id, payment.lineIndex);
        if (line.status != Status.Approved) revert InvalidState();
        line.status = Status.Paid;
        milestone.held -= line.budget;
        uint256 amount;
        address token;
        if (line.minMusdc == 0) {
            if (payment.extraMusd != 0 || payment.minOut != 0) revert InvalidState();
            amount = line.budget;
            token = address(musd);
            musd.safeTransfer(line.recipient, amount);
        } else {
            if (payment.minOut == 0) revert InvalidState();
            uint256 input = line.budget + payment.extraMusd;
            uint256 minimum = payment.minOut > line.minMusdc ? payment.minOut : line.minMusdc;
            if (payment.extraMusd > 0) musd.safeTransferFrom(milestone.owner, address(this), payment.extraMusd);
            uint256 beforeBalance = musdc.balanceOf(line.recipient);
            musd.forceApprove(address(router), input);
            router.swapExactTokensForTokens(input, minimum, _route(), line.recipient, deadline);
            musd.forceApprove(address(router), 0);
            amount = musdc.balanceOf(line.recipient) - beforeBalance;
            if (amount < minimum) revert InsufficientPayout(amount, minimum);
            token = address(musdc);
        }
        line.amountPaid = amount;
        emit Paid(id, payment.lineIndex, line.recipient, token, amount, payment.extraMusd);
    }

    function _line(uint256 id, uint256 lineIndex) private view returns (Line storage) {
        if (lineIndex >= milestoneLines[id].length) revert InvalidLine();
        return milestoneLines[id][lineIndex];
    }

    function _route() private view returns (IMezoRouter.Route[] memory route) {
        route = new IMezoRouter.Route[](1);
        route[0] = IMezoRouter.Route(address(musd), address(musdc), true, factory);
    }
}
