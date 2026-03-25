import * as mongoose from "mongoose";
import config from "./config";

export const databaseProviders = [
  {
    provide: "DATABASE_CONNECTION",
    useFactory: async (): Promise<typeof mongoose> => {
      return mongoose.connect(config.MONGODB_URI);
    },
  },
];
