import { PublicShareScreen } from "@/features/share/PublicShareScreen";

/**
 * A public link's page (`/s/?t=<token>`): a file handed to someone outside the space. A page of its
 * own, exported like the others, so it needs no session and loads none of the app.
 */
export default function SharedFile() {
  return <PublicShareScreen />;
}
