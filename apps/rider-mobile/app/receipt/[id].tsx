import { useLocalSearchParams } from 'expo-router';
import { ReceiptScreen } from '../../src/screens/HistoryScreens';

export default function ReceiptRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ReceiptScreen rideId={id} />;
}
