import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  POLL_CONTRACT_ID,
  POLL_NETWORK_PASSPHRASE,
  POLL_OPTIONS,
  POLL_RPC_URL,
  buildExplorerTransactionUrl,
  createEventServer,
  createReadClient,
  createSigningClient,
  parseVoteEvent,
  voteEventsFilter,
} from './lib/pollClient'
import { KitEventType, StellarWalletsKit, initWalletKit } from './lib/walletKit'
import './App.css'

const defaultCounts = Object.fromEntries(
  POLL_OPTIONS.map(({ symbol }) => [symbol, 0]),
)

const contractIdPreview = `${POLL_CONTRACT_ID.slice(0, 12)}...${POLL_CONTRACT_ID.slice(-8)}`

const readClient = createReadClient()
const WALLET_DISCONNECT_STORAGE_KEY = 'live-poll-wallet-manual-disconnect'

const createIdleTransactionState = () => ({
  phase: 'idle',
  option: '',
  txHash: '',
  message: 'No vote submitted yet.',
})

const readManualDisconnectPreference = () => {
  if (typeof window === 'undefined') {
    return false
  }

  return window.localStorage.getItem(WALLET_DISCONNECT_STORAGE_KEY) === 'true'
}

const writeManualDisconnectPreference = (shouldStayDisconnected) => {
  if (typeof window === 'undefined') {
    return
  }

  if (shouldStayDisconnected) {
    window.localStorage.setItem(WALLET_DISCONNECT_STORAGE_KEY, 'true')
    return
  }

  window.localStorage.removeItem(WALLET_DISCONNECT_STORAGE_KEY)
}

const formatAddress = (address) =>
  `${address.slice(0, 6)}...${address.slice(-6)}`

const formatError = (error) => {
  if (!error) {
    return 'Something went wrong.'
  }

  if (typeof error === 'string') {
    return error
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong.'
}

const formatNetworkName = (passphrase) => {
  if (!passphrase) {
    return 'Unknown network'
  }

  if (passphrase === POLL_NETWORK_PASSPHRASE) {
    return 'Stellar Testnet'
  }

  if (passphrase === 'Public Global Stellar Network ; September 2015') {
    return 'Stellar Public'
  }

  return passphrase
}

const getOptionLabel = (option) =>
  POLL_OPTIONS.find(({ symbol }) => symbol === option)?.label ?? option

const classifyError = (error) => {
  const message = formatError(error)
  const lowerMessage = message.toLowerCase()
  const lowerName = error?.constructor?.name?.toLowerCase?.() ?? ''

  if (
    lowerName.includes('userrejected') ||
    lowerMessage.includes('rejected') ||
    lowerMessage.includes('denied') ||
    lowerMessage.includes('declined') ||
    lowerMessage.includes('cancelled') ||
    lowerMessage.includes('canceled')
  ) {
    return {
      kind: 'user-rejected',
      message: 'The wallet request was rejected, so the transaction was not signed.',
    }
  }

  if (
    lowerMessage.includes('underfunded') ||
    lowerMessage.includes('insufficient balance') ||
    lowerMessage.includes('insufficient fee') ||
    (lowerMessage.includes('insufficient') && lowerMessage.includes('balance'))
  ) {
    return {
      kind: 'insufficient-balance',
      message: 'This wallet does not have enough Testnet XLM to pay the transaction fee.',
    }
  }

  if (
    lowerName.includes('nosigner') ||
    lowerMessage.includes('not available') ||
    lowerMessage.includes('wallet not found') ||
    lowerMessage.includes('install or unlock') ||
    lowerMessage.includes('install') ||
    lowerMessage.includes('unlock')
  ) {
    return {
      kind: 'wallet-not-found',
      message: 'No supported wallet is ready in this browser. Install or unlock one, then try again.',
    }
  }

  return {
    kind: 'unknown',
    message,
  }
}

const walletToneByState = {
  ready: 'success',
  warning: 'warning',
  empty: 'danger',
  idle: 'muted',
}

const syncToneByState = {
  starting: 'muted',
  live: 'success',
  error: 'danger',
}

const transactionToneByPhase = {
  idle: 'muted',
  pending: 'warning',
  success: 'success',
  failed: 'danger',
}

function App() {
  const [counts, setCounts] = useState(defaultCounts)
  const [isLoadingVotes, setIsLoadingVotes] = useState(true)
  const [isRefreshingVotes, setIsRefreshingVotes] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [walletError, setWalletError] = useState('')
  const [voteError, setVoteError] = useState('')
  const [walletAddress, setWalletAddress] = useState('')
  const [walletNetwork, setWalletNetwork] = useState('')
  const [walletPassphrase, setWalletPassphrase] = useState('')
  const [supportedWallets, setSupportedWallets] = useState([])
  const [isLoadingWallets, setIsLoadingWallets] = useState(true)
  const [selectedWalletId, setSelectedWalletId] = useState('')
  const [isConnectingWalletId, setIsConnectingWalletId] = useState('')
  const [lastUpdatedAt, setLastUpdatedAt] = useState('')
  const [copiedContract, setCopiedContract] = useState(false)
  const [lastReceipt, setLastReceipt] = useState(null)
  const [lastEvent, setLastEvent] = useState(null)
  const [transactionState, setTransactionState] = useState(
    createIdleTransactionState(),
  )
  const shouldStayDisconnectedRef = useRef(readManualDisconnectPreference())
  const [syncState, setSyncState] = useState({
    status: 'starting',
    message: 'Connecting to Soroban events...',
  })

  const isWalletConnected = Boolean(walletAddress)
  const isOnTestnet = walletPassphrase === POLL_NETWORK_PASSPHRASE

  const selectedWallet = useMemo(
    () => supportedWallets.find(({ id }) => id === selectedWalletId) ?? null,
    [selectedWalletId, supportedWallets],
  )

  const availableWallets = useMemo(
    () => supportedWallets.filter(({ isAvailable }) => isAvailable),
    [supportedWallets],
  )

  const availableWalletCount = useMemo(
    () => availableWallets.length,
    [availableWallets],
  )

  const totalVotes = useMemo(
    () =>
      POLL_OPTIONS.reduce(
        (sum, { symbol }) => sum + (counts[symbol] ?? 0),
        0,
      ),
    [counts],
  )

  const leadingOption = useMemo(() => {
    if (!totalVotes) {
      return 'No votes yet'
    }

    const highestVoteCount = Math.max(
      ...POLL_OPTIONS.map(({ symbol }) => counts[symbol] ?? 0),
    )
    const leaders = POLL_OPTIONS.filter(
      ({ symbol }) => (counts[symbol] ?? 0) === highestVoteCount,
    )

    if (leaders.length !== 1) {
      return 'Draw'
    }

    return leaders[0].label
  }, [counts, totalVotes])

  const walletState = (() => {
    if (isConnectingWalletId) {
      return {
        label: 'Connecting wallet',
        tone: walletToneByState.idle,
      }
    }

    if (!availableWalletCount && !isLoadingWallets) {
      return {
        label: 'No wallet detected',
        tone: walletToneByState.empty,
      }
    }

    if (!isWalletConnected) {
      return {
        label: 'Choose a wallet',
        tone: walletToneByState.idle,
      }
    }

    if (!isOnTestnet) {
      return {
        label: 'Switch wallet to Testnet',
        tone: walletToneByState.warning,
      }
    }

    return {
      label: 'Ready to vote',
      tone: walletToneByState.ready,
    }
  })()

  const transactionTone =
    transactionToneByPhase[transactionState.phase] ?? 'muted'

  const syncTone = syncToneByState[syncState.status] ?? 'muted'

  const clearWalletConnectionState = useCallback(() => {
    setWalletAddress('')
    setWalletPassphrase('')
    setWalletNetwork('')
  }, [])

  const loadVotes = useCallback(async ({ silent = false } = {}) => {
    if (silent) {
      setIsRefreshingVotes(true)
    } else {
      setIsLoadingVotes(true)
    }

    setRefreshError('')

    try {
      const results = await Promise.all(
        POLL_OPTIONS.map(({ symbol }) =>
          readClient.get_votes({
            option: symbol,
          }),
        ),
      )

      setCounts(
        Object.fromEntries(
          POLL_OPTIONS.map((option, index) => [
            option.symbol,
            Number(results[index].result ?? 0),
          ]),
        ),
      )
      setLastUpdatedAt(new Date().toLocaleTimeString())
    } catch (error) {
      setRefreshError(formatError(error))
    } finally {
      setIsLoadingVotes(false)
      setIsRefreshingVotes(false)
    }
  }, [])

  const refreshWallets = useCallback(async () => {
    setIsLoadingWallets(true)
    setWalletError('')

    try {
      initWalletKit()
      const wallets = await StellarWalletsKit.refreshSupportedWallets()
      setSupportedWallets(wallets)
      setSelectedWalletId((currentWalletId) => {
        if (wallets.some(({ id }) => id === currentWalletId)) {
          return currentWalletId
        }

        return wallets.find(({ isAvailable }) => isAvailable)?.id ?? wallets[0]?.id ?? ''
      })
    } catch (error) {
      setWalletError(formatError(error))
    } finally {
      setIsLoadingWallets(false)
    }
  }, [])

  const applyParsedVoteEvent = useCallback((parsedEvent) => {
    if (!parsedEvent || !(parsedEvent.option in defaultCounts)) {
      return
    }

    setCounts((currentCounts) => {
      if ((currentCounts[parsedEvent.option] ?? 0) === parsedEvent.votes) {
        return currentCounts
      }

      return {
        ...currentCounts,
        [parsedEvent.option]: parsedEvent.votes,
      }
    })

    setLastUpdatedAt(
      new Date(parsedEvent.ledgerClosedAt || Date.now()).toLocaleTimeString(),
    )
    setLastEvent(parsedEvent)
  }, [])

  const connectWallet = useCallback(async (wallet) => {
    setVoteError('')
    setWalletError('')

    if (!wallet) {
      setWalletError('Choose a wallet option first.')
      return null
    }

    if (!wallet.isAvailable) {
      setWalletError(
        `${wallet.name} is not available in this browser. Install or unlock it first.`,
      )
      return null
    }

    setIsConnectingWalletId(wallet.id)

    try {
      initWalletKit()
      StellarWalletsKit.setWallet(wallet.id)

      const { address } = await StellarWalletsKit.fetchAddress()
      const networkDetails = await StellarWalletsKit.getNetwork()
      const networkPassphrase = networkDetails.networkPassphrase || ''
      const networkName =
        networkDetails.network || formatNetworkName(networkPassphrase)

      shouldStayDisconnectedRef.current = false
      writeManualDisconnectPreference(false)
      setSelectedWalletId(wallet.id)
      setWalletAddress(address)
      setWalletPassphrase(networkPassphrase)
      setWalletNetwork(networkName)

      return {
        address,
        networkPassphrase,
        networkName,
      }
    } catch (error) {
      setWalletError(classifyError(error).message)
      return null
    } finally {
      setIsConnectingWalletId('')
    }
  }, [])

  const disconnectWallet = useCallback(async () => {
    setVoteError('')
    setWalletError('')

    try {
      shouldStayDisconnectedRef.current = true
      writeManualDisconnectPreference(true)
      await StellarWalletsKit.disconnect()
      clearWalletConnectionState()
    } catch (error) {
      shouldStayDisconnectedRef.current = false
      writeManualDisconnectPreference(false)
      setWalletError(formatError(error))
    }
  }, [clearWalletConnectionState])

  const handleVote = useCallback(
    async (option) => {
      setVoteError('')
      setWalletError('')

      let activeAddress = walletAddress
      let activePassphrase = walletPassphrase

      if (!activeAddress) {
        if (!selectedWallet) {
          setVoteError('Choose a wallet option before you vote.')
          return
        }

        const connection = await connectWallet(selectedWallet)

        if (!connection) {
          return
        }

        activeAddress = connection.address
        activePassphrase = connection.networkPassphrase
      }

      if (activePassphrase !== POLL_NETWORK_PASSPHRASE) {
        setVoteError(
          `Switch ${selectedWallet?.name ?? 'your wallet'} to Testnet before you submit a vote.`,
        )
        return
      }

      setTransactionState({
        phase: 'pending',
        option,
        txHash: '',
        message: `Awaiting signature for ${getOptionLabel(option)}...`,
      })

      try {
        const client = createSigningClient(activeAddress, async (xdr, options) => {
          const signed = await StellarWalletsKit.signTransaction(xdr, {
            address: activeAddress,
            networkPassphrase:
              options?.networkPassphrase ?? POLL_NETWORK_PASSPHRASE,
          })

          return {
            signedTxXdr: signed.signedTxXdr,
            signerAddress: signed.signerAddress,
          }
        })

        const assembled = await client.vote({
          option,
        })

        const sent = await assembled.signAndSend({
          watcher: {
            onSubmitted: (response) => {
              if (!response?.hash) {
                return
              }

              setTransactionState((currentState) => ({
                ...currentState,
                txHash: response.hash,
                message: 'Transaction submitted. Waiting for final confirmation...',
              }))
            },
          },
        })

        const txHash =
          sent.getTransactionResponse?.txHash ??
          sent.sendTransactionResponse?.hash ??
          ''

        setLastReceipt({
          option,
          txHash,
        })
        setTransactionState({
          phase: 'success',
          option,
          txHash,
          message: `${getOptionLabel(option)} is now confirmed on Testnet.`,
        })

        await loadVotes({ silent: true })
      } catch (error) {
        setTransactionState({
          phase: 'failed',
          option,
          txHash: '',
          message: classifyError(error).message,
        })
      }
    },
    [connectWallet, loadVotes, selectedWallet, walletAddress, walletPassphrase],
  )

  const copyContractId = async () => {
    try {
      await navigator.clipboard.writeText(POLL_CONTRACT_ID)
      setCopiedContract(true)
      window.setTimeout(() => setCopiedContract(false), 1800)
    } catch {
      setVoteError('Clipboard access failed. Copy the contract ID manually.')
    }
  }

  useEffect(() => {
    let isCancelled = false
    const initTimeoutId = window.setTimeout(() => {
      void refreshWallets()
      void loadVotes()
    }, 0)

    initWalletKit()

    if (shouldStayDisconnectedRef.current) {
      void StellarWalletsKit.disconnect().catch(() => {
        clearWalletConnectionState()
      })
      clearWalletConnectionState()
    }

    const unsubscribeStateUpdated = StellarWalletsKit.on(
      KitEventType.STATE_UPDATED,
      ({ payload }) => {
        if (isCancelled) {
          return
        }

        if (shouldStayDisconnectedRef.current) {
          clearWalletConnectionState()
          return
        }

        setWalletAddress(payload.address || '')
        setWalletPassphrase(payload.networkPassphrase || '')
        setWalletNetwork(formatNetworkName(payload.networkPassphrase))
      },
    )

    const unsubscribeWalletSelected = StellarWalletsKit.on(
      KitEventType.WALLET_SELECTED,
      ({ payload }) => {
        if (isCancelled) {
          return
        }

        setSelectedWalletId(payload.id || '')
      },
    )

    const unsubscribeDisconnect = StellarWalletsKit.on(
      KitEventType.DISCONNECT,
      () => {
        if (isCancelled) {
          return
        }

        clearWalletConnectionState()
      },
    )

    return () => {
      isCancelled = true
      window.clearTimeout(initTimeoutId)
      unsubscribeStateUpdated?.()
      unsubscribeWalletSelected?.()
      unsubscribeDisconnect?.()
    }
  }, [clearWalletConnectionState, loadVotes, refreshWallets])

  useEffect(() => {
    let isCancelled = false
    let cursor = ''
    let pollTimeoutId = 0

    const eventServer = createEventServer()

    const schedulePoll = (delay) => {
      pollTimeoutId = window.setTimeout(() => {
        void pollEvents()
      }, delay)
    }

    const applyEvents = (events) => {
      const parsedEvents = events.map(parseVoteEvent).filter(Boolean)

      if (!parsedEvents.length) {
        return false
      }

      parsedEvents.forEach((event) => applyParsedVoteEvent(event))

      const newestEvent = parsedEvents[parsedEvents.length - 1]
      setSyncState({
        status: 'live',
        message: `Live from ledger ${newestEvent.ledger}.`,
      })

      return true
    }

    const bootstrapEvents = async () => {
      setSyncState({
        status: 'starting',
        message: 'Connecting to Soroban events...',
      })

      try {
        const latestLedger = await eventServer.getLatestLedger()

        if (isCancelled) {
          return
        }

        const response = await eventServer.getEvents({
          startLedger: Math.max(latestLedger.sequence - 2, 1),
          filters: [voteEventsFilter],
          limit: 25,
        })

        if (isCancelled) {
          return
        }

        cursor = response.cursor
        const hadEvents = applyEvents(response.events)

        if (!hadEvents) {
          setSyncState({
            status: 'live',
            message: `Listening live from ledger ${latestLedger.sequence}.`,
          })
        }

        schedulePoll(4000)
      } catch (error) {
        if (isCancelled) {
          return
        }

        setSyncState({
          status: 'error',
          message: `Event sync unavailable: ${formatError(error)}`,
        })
        schedulePoll(12000)
      }
    }

    const pollEvents = async () => {
      if (!cursor) {
        await bootstrapEvents()
        return
      }

      try {
        const response = await eventServer.getEvents({
          cursor,
          filters: [voteEventsFilter],
          limit: 25,
        })

        if (isCancelled) {
          return
        }

        cursor = response.cursor
        const hadEvents = applyEvents(response.events)

        if (!hadEvents) {
          setSyncState((currentState) =>
            currentState.status === 'error'
              ? {
                  status: 'live',
                  message: 'Event stream reconnected. Listening for new votes.',
                }
              : currentState,
          )
        }

        schedulePoll(4000)
      } catch (error) {
        if (isCancelled) {
          return
        }

        setSyncState({
          status: 'error',
          message: `Event sync paused: ${formatError(error)}`,
        })
        schedulePoll(12000)
      }
    }

    void bootstrapEvents()

    return () => {
      isCancelled = true
      window.clearTimeout(pollTimeoutId)
    }
  }, [applyParsedVoteEvent])

  return (
    <div className="app-shell">
      <section className="band masthead-band">
        <div className="band-inner masthead">
          <div className="masthead-copy">
            <span className="eyebrow">Stellar Testnet Live Poll</span>
            <h1>Vote on-chain, watch the tally move.</h1>
            <p className="lead">
              This frontend now supports multiple Stellar wallets, shows live
              transaction status, and syncs poll activity from Soroban events.
            </p>
          </div>

          <div className="masthead-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={refreshWallets}
              disabled={isLoadingWallets}
            >
              {isLoadingWallets ? 'Checking wallets...' : 'Refresh wallets'}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => loadVotes({ silent: true })}
              disabled={isRefreshingVotes}
            >
              {isRefreshingVotes ? 'Refreshing...' : 'Refresh counts'}
            </button>
            {isWalletConnected ? (
              <button
                type="button"
                className="primary-button"
                onClick={disconnectWallet}
              >
                Disconnect wallet
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="band overview-band">
        <div className="band-inner overview-grid">
          <div className="summary-panel">
            <div className="summary-header">
              <span className={`status-pill tone-${walletState.tone}`}>
                {walletState.label}
              </span>
              <span className={`sync-pill tone-${syncTone}`}>
                {syncState.status === 'live' ? 'Live sync on' : 'Live sync paused'}
              </span>
            </div>

            <div className="summary-metrics">
              <div>
                <span className="metric-label">Total votes</span>
                <strong>{totalVotes}</strong>
              </div>
              <div>
                <span className="metric-label">Leading option</span>
                <strong>{leadingOption}</strong>
              </div>
              <div>
                <span className="metric-label">Updated</span>
                <strong>{lastUpdatedAt || 'Checking now'}</strong>
              </div>
            </div>

            {walletAddress ? (
              <p className="wallet-line">
                Connected wallet <span>{formatAddress(walletAddress)}</span>
              </p>
            ) : (
              <p className="wallet-line muted">
                Pick any available wallet below to submit votes from the browser.
              </p>
            )}

            <p className="sync-line">{syncState.message}</p>
          </div>

          <div className="detail-panel">
            <div className="detail-row">
              <span>Contract</span>
              <div className="detail-value">
                <code>{contractIdPreview}</code>
                <button
                  type="button"
                  className="text-button"
                  onClick={copyContractId}
                >
                  {copiedContract ? 'Copied' : 'Copy ID'}
                </button>
              </div>
            </div>
            <div className="detail-row">
              <span>RPC</span>
              <code>{POLL_RPC_URL}</code>
            </div>
            <div className="detail-row">
              <span>Network</span>
              <code>{walletNetwork || 'Stellar Testnet'}</code>
            </div>
            <div className="detail-row">
              <span>Selected wallet</span>
              <code>{selectedWallet?.name || 'None yet'}</code>
            </div>
          </div>
        </div>
      </section>

      <section className="band wallet-band">
        <div className="band-inner">
          <div className="section-heading">
            <div>
              <h2>Wallet options</h2>
              <p>
                Multi-wallet support is powered by StellarWalletsKit. Choose one
                wallet from the menu, then connect with a single action.
              </p>
            </div>
            <span className="network-pill">
              {availableWalletCount} wallet
              {availableWalletCount === 1 ? '' : 's'} available
            </span>
          </div>

          {walletError ? (
            <div className="notice error-notice">{walletError}</div>
          ) : null}

          <div className="wallet-picker-panel">
            <div className="wallet-picker-controls">
              <label className="wallet-select-field" htmlFor="wallet-picker">
                <span>Choose wallet</span>
                <select
                  id="wallet-picker"
                  className="wallet-select"
                  value={selectedWalletId}
                  onChange={(event) => {
                    setSelectedWalletId(event.target.value)
                    setWalletError('')
                  }}
                  disabled={isLoadingWallets || !supportedWallets.length}
                >
                  {supportedWallets.length ? null : (
                    <option value="">No wallets found</option>
                  )}
                  {supportedWallets.map((wallet) => (
                    <option key={wallet.id} value={wallet.id}>
                      {wallet.name} · {wallet.isAvailable ? 'Available' : 'Not found'}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className="primary-button"
                onClick={() => connectWallet(selectedWallet)}
                disabled={
                  !selectedWallet?.isAvailable || Boolean(isConnectingWalletId)
                }
              >
                {isConnectingWalletId === selectedWallet?.id
                  ? 'Connecting...'
                  : isWalletConnected && selectedWallet?.id === selectedWalletId
                    ? `Reconnect ${selectedWallet?.name ?? 'wallet'}`
                    : `Connect ${selectedWallet?.name ?? 'wallet'}`}
              </button>
            </div>

            <div className="wallet-selection-meta">
              <div className="wallet-selection-copy">
                <h3>{selectedWallet?.name || 'No wallet selected'}</h3>
                <p className="wallet-meta">
                  {selectedWallet
                    ? `${selectedWallet.type} wallet`
                    : 'Refresh wallets to detect supported browser extensions.'}
                </p>
              </div>
              <span
                className={`availability-pill tone-${
                  selectedWallet?.isAvailable ? 'success' : 'muted'
                }`}
              >
                {selectedWallet?.isAvailable ? 'Available' : 'Not found'}
              </span>
            </div>

            <div className="wallet-selection-actions">
              <p className="muted">
                {availableWalletCount
                  ? `Detected ${availableWalletCount} ready wallet${
                      availableWalletCount === 1 ? '' : 's'
                    } in this browser.`
                  : 'No supported wallet is ready in this browser yet.'}
              </p>

              {selectedWallet?.url ? (
                <a href={selectedWallet.url} target="_blank" rel="noreferrer">
                  Open wallet page
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="band voting-band">
        <div className="band-inner">
          <div className="section-heading">
            <div>
              <h2>Vote board</h2>
              <p>
                Each vote becomes a real Soroban transaction, then the totals
                update from live contract events.
              </p>
            </div>
          </div>

          {refreshError ? (
            <div className="notice error-notice">{refreshError}</div>
          ) : null}

          {voteError ? <div className="notice error-notice">{voteError}</div> : null}

          {!isOnTestnet && isWalletConnected ? (
            <div className="notice warning-notice">
              {selectedWallet?.name || 'Your wallet'} is connected to{' '}
              {walletNetwork || 'another network'}. Switch it to Testnet before
              you submit a vote.
            </div>
          ) : null}

          <div className="options-grid">
            {POLL_OPTIONS.map(({ symbol, label, accentClass }) => {
              const votes = counts[symbol] ?? 0
              const share = totalVotes ? Math.round((votes / totalVotes) * 100) : 0
              const isPending =
                transactionState.phase === 'pending' &&
                transactionState.option === symbol

              return (
                <article key={symbol} className={`option-card ${accentClass}`}>
                  <div className="option-head">
                    <div>
                      <span className="option-chip">{symbol}</span>
                      <h3>{label}</h3>
                    </div>
                    <strong>{votes}</strong>
                  </div>

                  <div className="bar-track" aria-hidden="true">
                    <div className="bar-fill" style={{ width: `${share}%` }} />
                  </div>

                  <div className="option-meta">
                    <span>{share}% of recorded votes</span>
                    <span>{votes === 1 ? '1 vote' : `${votes} votes`}</span>
                  </div>

                  <button
                    type="button"
                    className="vote-button"
                    onClick={() => handleVote(symbol)}
                    disabled={
                      transactionState.phase === 'pending' || Boolean(isConnectingWalletId)
                    }
                  >
                    {isPending ? 'Submitting...' : `Vote for ${label}`}
                  </button>
                </article>
              )
            })}
          </div>

          {isLoadingVotes ? (
            <p className="loading-line">Loading current vote totals...</p>
          ) : null}
        </div>
      </section>

      <section className="band activity-band">
        <div className="band-inner activity-grid">
          <div className="activity-panel">
            <div className="panel-heading">
              <h2>Transaction status</h2>
              <span className={`tx-pill tone-${transactionTone}`}>
                {transactionState.phase}
              </span>
            </div>

            <p>{transactionState.message}</p>

            {transactionState.option ? (
              <p className="muted">
                Current option: <strong>{getOptionLabel(transactionState.option)}</strong>
              </p>
            ) : null}

            {transactionState.txHash ? (
              <a
                href={buildExplorerTransactionUrl(transactionState.txHash)}
                target="_blank"
                rel="noreferrer"
              >
                View transaction on Stellar Expert
              </a>
            ) : null}
          </div>

          <div className="activity-panel">
            <div className="panel-heading">
              <h2>Live activity</h2>
              <span className={`tx-pill tone-${syncTone}`}>
                {syncState.status}
              </span>
            </div>

            {lastReceipt ? (
              <div className="receipt">
                <p>
                  Last submitted vote: <strong>{getOptionLabel(lastReceipt.option)}</strong>
                </p>
                {lastReceipt.txHash ? (
                  <a
                    href={buildExplorerTransactionUrl(lastReceipt.txHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open latest receipt
                  </a>
                ) : null}
              </div>
            ) : (
              <p className="muted">
                Your next successful vote will show the transaction receipt here.
              </p>
            )}

            {lastEvent ? (
              <div className="event-card">
                <p>
                  Event sync last saw <strong>{getOptionLabel(lastEvent.option)}</strong>{' '}
                  reach <strong>{lastEvent.votes}</strong> votes.
                </p>
                <p className="muted">Ledger {lastEvent.ledger}</p>
                <a
                  href={buildExplorerTransactionUrl(lastEvent.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open event transaction
                </a>
              </div>
            ) : (
              <p className="muted">
                Waiting for the next on-chain vote event to arrive.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

export default App
