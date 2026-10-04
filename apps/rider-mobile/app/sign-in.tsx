import { router } from 'expo-router';
import { SignInScreen } from '../src/screens/SignInScreen';

export default function SignIn() {
  return <SignInScreen onSignedIn={() => router.replace('/(tabs)')} />;
}
