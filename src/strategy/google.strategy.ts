import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Profile, Strategy, VerifyCallback } from "passport-google-oauth20";
import {
  GOOGLE_CALLBACK_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
} from "app-config/config.json";
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
  constructor() {
    super({
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: GOOGLE_CALLBACK_URL,
      scope: ["email", "profile"],
    });
    // console.log("clientID:", GOOGLE_CLIENT_ID);
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback
  ): Promise<any> {
    const { name, emails, photos } = profile;
    const user = {
      email: emails && emails.length > 0 ? emails[0].value : undefined,
      name: name ? `${name.givenName} ${name.familyName}` : undefined,
      picture: photos && photos.length > 0 ? photos[0].value : undefined,
    };
    // console.log("Google profile:", profile);
    done(null, user);
  }
}
