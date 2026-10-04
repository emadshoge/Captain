import { router, useLocalSearchParams } from 'expo-router';
import { RideScreen } from '../../src/screens/RideScreen';

export default function RideRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RideScreen rideId={id} onClose={() => router.replace('/(tabs)')} />;
}
