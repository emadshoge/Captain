import { router } from 'expo-router';
import { HomeScreen } from '../../src/screens/HomeScreen';

export default function Home() {
  return (
    <HomeScreen
      onScan={() => router.push('/scan')}
      onOpenRide={(id) => router.push(`/ride/${id}`)}
    />
  );
}
