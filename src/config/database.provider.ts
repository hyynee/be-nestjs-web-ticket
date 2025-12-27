import * as mongoose from "mongoose";
import config from "./config";

export const databaseProviders = [
  {
    provide: "DATABASE_CONNECTION",
    useFactory: async (): Promise<typeof mongoose> => {
      const uri = config.MONGODB_URI || "mongodb://localhost:27017/ticket-be";
      return mongoose.connect(uri);
    },
  },
];

// nest g resource user --no-spec
