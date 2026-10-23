// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title Proof of Ship escrow
/// @notice Anyone puts tokens behind a builder; the tokens reach the builder only when Hey Research Lab attests that
///         the builder's project shipped — counted building evidence, each ship with its public source — after the
///         bounty opened. If the builder does not ship before the deadline, every funder takes back what they put in.
/// @dev    There is no owner and no admin function. The attester is fixed at deployment; it can only release a
///         bounty to the payout address its creator named, never redirect funds. Token-agnostic: any ERC-20 works,
///         fee-on-transfer tokens are credited with what actually arrived.
contract ShipEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice What Hey Research Lab signs: `ships` counted ships for `project` between `since` and `until`.
    /// @param project   keccak256 of the project's HEY slug (heyresearch.xyz/project/<slug>)
    /// @param since     window start (unix seconds), equal to the bounty's `start`
    /// @param until     window end (unix seconds); ships after the bounty's deadline never count
    /// @param ships     number of ships HEY counted as building in the window
    /// @param evidence  keccak256 of the sorted ship evidence ids (`ship:<uuid>`) the count rests on
    /// @param issuedAt  when HEY signed it
    struct Ships {
        bytes32 project;
        uint64 since;
        uint64 until;
        uint32 ships;
        bytes32 evidence;
        uint64 issuedAt;
    }

    struct Bounty {
        address token;
        address builder;
        bytes32 project;
        uint64 start;
        uint64 deadline;
        uint32 minShips;
        uint16 burnBps;
        bool paid;
        uint256 total;
    }

    bytes32 public constant SHIPS_TYPEHASH = keccak256(
        "Ships(bytes32 project,uint64 since,uint64 until,uint32 ships,bytes32 evidence,uint64 issuedAt)"
    );
    /// @notice An attestation older than this cannot be used.
    uint256 public constant MAX_ATTESTATION_AGE = 1 days;
    /// @notice After the deadline the builder still has this long to claim with ships made before the deadline;
    ///         refunds open when it ends.
    uint256 public constant CLAIM_GRACE = 3 days;
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 365 days;
    /// @notice The most a bounty may burn on payout, in basis points.
    uint16 public constant MAX_BURN_BPS = 1_000;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice The only key whose signature releases a bounty. Immutable.
    address public immutable attester;

    Bounty[] private _bounties;
    mapping(uint256 id => mapping(address funder => uint256 amount)) public contributed;
    /// @notice The HEY slug each bounty was opened for (its `project` is keccak256 of these bytes).
    mapping(uint256 id => string slug) public slugOf;

    event BountyCreated(
        uint256 indexed id,
        address indexed token,
        address indexed builder,
        bytes32 project,
        string slug,
        uint32 minShips,
        uint64 start,
        uint64 deadline,
        uint16 burnBps
    );
    event Funded(uint256 indexed id, address indexed funder, uint256 amount, uint256 total);
    event Claimed(uint256 indexed id, address indexed builder, uint256 paid, uint256 burned, uint32 ships, bytes32 evidence);
    event Refunded(uint256 indexed id, address indexed funder, uint256 amount);

    error ZeroAddress();
    error NotAToken();
    error BadSlug();
    error BadMinShips();
    error BadDeadline();
    error BurnTooHigh();
    error UnknownBounty();
    error AlreadyPaid();
    error FundingClosed();
    error NothingReceived();
    error ClaimClosed();
    error WrongProject();
    error WrongWindow();
    error StaleAttestation();
    error NotEnoughShips();
    error BadSignature();
    error NothingFunded();
    error RefundNotOpen();
    error NothingToRefund();

    constructor(address attester_) EIP712("HEY Proof of Ship", "1") {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
    }

    // ------------------------------------------------------------------ bounties

    /// @notice Open a bounty: `builder` is paid once HEY counts `minShips` ships for `slug` from now until `deadline`.
    /// @param amount optional first funding, pulled from the caller (approve first); 0 opens it unfunded.
    function create(
        address token,
        address builder,
        string calldata slug,
        uint32 minShips,
        uint64 deadline,
        uint16 burnBps,
        uint256 amount
    ) external nonReentrant returns (uint256 id) {
        if (token == address(0) || builder == address(0)) revert ZeroAddress();
        if (token.code.length == 0) revert NotAToken();
        uint256 len = bytes(slug).length;
        if (len == 0 || len > 128) revert BadSlug();
        if (minShips == 0) revert BadMinShips();
        if (deadline < block.timestamp + MIN_DURATION || deadline > block.timestamp + MAX_DURATION) revert BadDeadline();
        if (burnBps > MAX_BURN_BPS) revert BurnTooHigh();

        id = _bounties.length;
        bytes32 project = keccak256(bytes(slug));
        _bounties.push(
            Bounty({
                token: token,
                builder: builder,
                project: project,
                start: uint64(block.timestamp),
                deadline: deadline,
                minShips: minShips,
                burnBps: burnBps,
                paid: false,
                total: 0
            })
        );
        slugOf[id] = slug;
        emit BountyCreated(id, token, builder, project, slug, minShips, uint64(block.timestamp), deadline, burnBps);
        if (amount != 0) _fund(id, amount);
    }

    /// @notice Add to a bounty that is still open. Anyone can fund any bounty; each funder can take back exactly what
    ///         they put in if the bounty is not claimed.
    function fund(uint256 id, uint256 amount) external nonReentrant {
        _fund(id, amount);
    }

    /// @notice Release a bounty with a HEY attestation. Anyone may submit it; the tokens always go to the bounty's
    ///         builder (minus the bounty's burn share, sent to the dead address).
    function claim(uint256 id, Ships calldata att, bytes calldata signature) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paid) revert AlreadyPaid();
        if (block.timestamp > uint256(b.deadline) + CLAIM_GRACE) revert ClaimClosed();
        if (b.total == 0) revert NothingFunded();
        if (att.project != b.project) revert WrongProject();
        if (att.since != b.start || att.until < att.since || att.until > b.deadline || att.until > att.issuedAt) {
            revert WrongWindow();
        }
        if (att.issuedAt > block.timestamp || block.timestamp - att.issuedAt > MAX_ATTESTATION_AGE) {
            revert StaleAttestation();
        }
        if (att.ships < b.minShips) revert NotEnoughShips();
        if (ECDSA.recover(_hashTypedDataV4(_structHash(att)), signature) != attester) revert BadSignature();

        b.paid = true;
        uint256 total = b.total;
        uint256 burned = (total * b.burnBps) / 10_000;
        uint256 paid = total - burned;
        IERC20 token = IERC20(b.token);
        if (burned != 0) token.safeTransfer(BURN_ADDRESS, burned);
        token.safeTransfer(b.builder, paid);
        emit Claimed(id, b.builder, paid, burned, att.ships, att.evidence);
    }

    /// @notice Take back your contribution once the claim window has closed without a claim.
    function refund(uint256 id) external nonReentrant {
        Bounty storage b = _bounty(id);
        if (b.paid) revert AlreadyPaid();
        if (block.timestamp <= uint256(b.deadline) + CLAIM_GRACE) revert RefundNotOpen();
        uint256 amount = contributed[id][msg.sender];
        if (amount == 0) revert NothingToRefund();
        contributed[id][msg.sender] = 0;
        b.total -= amount;
        IERC20(b.token).safeTransfer(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function bountyCount() external view returns (uint256) {
        return _bounties.length;
    }

    function bounty(uint256 id) external view returns (Bounty memory) {
        return _bounty(id);
    }

    /// @notice The EIP-712 digest HEY signs for `att` (domain: "HEY Proof of Ship", version "1", this chain, this
    ///         contract).
    function digest(Ships calldata att) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(att));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------ internal

    function _fund(uint256 id, uint256 amount) internal {
        Bounty storage b = _bounty(id);
        if (b.paid) revert AlreadyPaid();
        if (block.timestamp >= b.deadline) revert FundingClosed();
        IERC20 token = IERC20(b.token);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received == 0) revert NothingReceived();
        contributed[id][msg.sender] += received;
        b.total += received;
        emit Funded(id, msg.sender, received, b.total);
    }

    function _bounty(uint256 id) internal view returns (Bounty storage) {
        if (id >= _bounties.length) revert UnknownBounty();
        return _bounties[id];
    }

    function _structHash(Ships calldata att) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(SHIPS_TYPEHASH, att.project, att.since, att.until, att.ships, att.evidence, att.issuedAt)
        );
    }
}
