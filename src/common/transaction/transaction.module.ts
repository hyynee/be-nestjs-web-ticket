import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionHelper } from '@src/helper/transaction.helper';

@Module({
  imports: [MongooseModule],
  providers: [TransactionHelper],
  exports: [TransactionHelper],
})
export class TransactionModule {}
