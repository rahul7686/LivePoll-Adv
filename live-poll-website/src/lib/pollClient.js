import {
  Client as LivePollClient,
  networks,
} from '@contract-client'
import { nativeToScVal, rpc, scValToNative } from '@stellar/stellar-sdk'

export const POLL_RPC_URL = 'https://stellar-soroban-testnet-public.nodies.app'
export const POLL_NETWORK_PASSPHRASE = networks.testnet.networkPassphrase
export const POLL_CONTRACT_ID = networks.testnet.contractId
export const POLL_OPTIONS = [
  {
    symbol: 'OptionA',
    label: 'Option A',
    accentClass: 'mint',
  },
  {
    symbol: 'OptionB',
    label: 'Option B',
    accentClass: 'coral',
  },
]

const sharedClientOptions = {
  ...networks.testnet,
  rpcUrl: POLL_RPC_URL,
}

export const createReadClient = () => new LivePollClient(sharedClientOptions)

export const createSigningClient = (address, signWithWallet) =>
  new LivePollClient({
    ...sharedClientOptions,
    publicKey: address,
    signTransaction: (xdr, options) =>
      signWithWallet(xdr, {
        ...options,
        address,
      }),
  })

export const createEventServer = () => new rpc.Server(POLL_RPC_URL)

export const VOTED_EVENT_TOPIC_XDR = nativeToScVal('voted', {
  type: 'symbol',
}).toXDR('base64')

export const voteEventsFilter = {
  type: 'contract',
  contractIds: [POLL_CONTRACT_ID],
  topics: [[VOTED_EVENT_TOPIC_XDR]],
}

export const parseVoteEvent = (event) => {
  if (!event?.topic || event.topic.length < 2) {
    return null
  }

  const eventName = scValToNative(event.topic[0])
  const option = scValToNative(event.topic[1])
  const votes = Number(scValToNative(event.value))

  if (eventName !== 'voted' || !option || !Number.isFinite(votes)) {
    return null
  }

  return {
    option: String(option),
    votes,
    txHash: event.txHash,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
  }
}

export const buildExplorerTransactionUrl = (hash) =>
  `https://stellar.expert/explorer/testnet/tx/${hash}`
