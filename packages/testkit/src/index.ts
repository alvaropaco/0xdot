import { DestinationEmulator, McpEmulator } from "@rakazo/adapters";

export { DestinationEmulator, McpEmulator } from "@rakazo/adapters";

/**
 * There are no accounts: the API acts as its single deployment owner for every
 * request. Test helpers still thread this value through their `cookie` headers
 * so call sites read the same as before; the server ignores it.
 */
export const OWNER_COOKIE = "x-owner-journey=1";
