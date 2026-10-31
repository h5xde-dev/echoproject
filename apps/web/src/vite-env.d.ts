/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Self-hosted PeerServer, `host:port` or a URL. */
  readonly VITE_PEER_SIGNAL?: string;
  /** JSON list of extra ICE (TURN) servers. */
  readonly VITE_ICE_SERVERS?: string;
}
