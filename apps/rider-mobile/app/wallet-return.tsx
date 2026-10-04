import { Redirect } from 'expo-router';

/**
 * Deep link target after checkout (captain://wallet-return). Returning from
 * the payment page proves nothing; the wallet screen asks the server to
 * verify the payment.
 */
export default function WalletReturn() {
  return <Redirect href="/(tabs)/wallet" />;
}
