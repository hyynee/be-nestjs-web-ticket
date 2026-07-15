import * as bcrypt from "bcrypt";
import { UserSchema } from "./user.schema";

// Bind UserSchema.methods.comparePassword to a plain object so we can test
// the async schema method in isolation without a MongoDB connection.
function makeUser(password: string | undefined) {
  const obj: any = { password };
  obj.comparePassword = UserSchema.methods.comparePassword.bind(obj);
  return obj;
}

describe("User.comparePassword (schema method)", () => {
  const CORRECT = "Secret123!";
  const WRONG = "WrongPass999";

  let user: ReturnType<typeof makeUser>;

  beforeAll(async () => {
    const hash = await bcrypt.hash(CORRECT, 10);
    user = makeUser(hash);
  });

  // 🔴 Data Integrity — wrong password MUST return false, never a truthy Promise
  it("resolves false for wrong password", async () => {
    await expect(user.comparePassword(WRONG)).resolves.toBe(false);
  });

  it("resolves true for correct password", async () => {
    await expect(user.comparePassword(CORRECT)).resolves.toBe(true);
  });

  // 🔴 Edge case — OAuth users have no stored password
  it("resolves false when no password is stored", async () => {
    const oauthUser = makeUser(undefined);
    await expect(oauthUser.comparePassword(CORRECT)).resolves.toBe(false);
  });

  // 🟠 Security — return value must be a Promise (forces callers to await)
  it("returns a Promise, not a boolean", () => {
    const result = user.comparePassword(WRONG);
    expect(result).toBeInstanceOf(Promise);
    return result; // let Jest collect the resolved value
  });
});
