import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.getOrThrow<string>("MONGODB_URI"),
        maxPoolSize: 50,
        connectTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
        writeConcern: { w: "majority", j: true, wtimeoutMS: 10_000 },
      }),
    }),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
