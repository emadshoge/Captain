import { router } from 'expo-router';
import { HistoryScreen } from '../../src/screens/HistoryScreens';

export default function History() {
  return <HistoryScreen onOpen={(id) => router.push(`/receipt/${id}`)} />;
}
