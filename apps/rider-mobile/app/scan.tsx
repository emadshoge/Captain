import { router } from 'expo-router';
import { ScanScreen } from '../src/screens/ScanScreen';

export default function Scan() {
  return <ScanScreen onStarted={(id) => router.replace(`/ride/${id}`)} />;
}
