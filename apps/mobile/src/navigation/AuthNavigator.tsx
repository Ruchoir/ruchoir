import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { ForgotPasswordScreen } from "../screens/auth/ForgotPasswordScreen";
import { InvitationLinkScreen } from "../screens/auth/InvitationLinkScreen";
import { SignInScreen } from "../screens/auth/SignInScreen";
import { SignUpScreen } from "../screens/auth/SignUpScreen";
import { VerifyEmailScreen } from "../screens/auth/VerifyEmailScreen";
import { TutorialScreen } from "../screens/welcome/TutorialScreen";
import { WelcomeScreen } from "../screens/welcome/WelcomeScreen";
import { useSession } from "../session/SessionProvider";
import { useNavigationTheme } from "./navigationTheme";
import type { AuthParams } from "./types";

const Stack = createNativeStackNavigator<AuthParams>();

/**
 * Everything before signing in: the welcome and its tutorial, sign-in, sign-up and its address
 * confirmation, and the forgotten password. A session that ended, or a person back from the second
 * factor, starts at sign-in; anyone else at the welcome.
 */
export function AuthNavigator() {
  const theme = useNavigationTheme();
  const { state } = useSession();
  const toSignIn = state.kind === "signedOut" && state.reason !== undefined;
  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator initialRouteName={toSignIn ? "signIn" : "welcome"} screenOptions={{ headerShown: false }}>
        <Stack.Screen name="welcome" component={WelcomeScreen} />
        <Stack.Screen name="tutorial" component={TutorialScreen} />
        <Stack.Screen name="signIn" component={SignInScreen} />
        <Stack.Screen name="signUp" component={SignUpScreen} />
        <Stack.Screen name="invitationLink" component={InvitationLinkScreen} options={{ presentation: "modal" }} />
        <Stack.Screen name="verifyEmail" component={VerifyEmailScreen} options={{ gestureEnabled: false }} />
        <Stack.Screen name="forgotPassword" component={ForgotPasswordScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
