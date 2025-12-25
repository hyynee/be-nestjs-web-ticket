import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Injectable()
export class TransactionHelper {
  constructor(
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async runInTransaction<T>(callback: (session: any) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      const result = await callback(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }
}