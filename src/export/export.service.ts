import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Ticket } from '@src/schemas/ticket.schema';
import { Zone } from '@src/schemas/zone.schema';
import { ExportTicketDto } from './dto/export-ticket.dto';
import { Response } from 'express';
import { exportCSV, exportExcel } from '@src/helper/export.helper';
import { ExportCheckInDto } from './dto/export-checkin.dto';


@Injectable()
export class ExportService {
    constructor(
        @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
        @InjectModel(Zone.name) private zoneModel: Model<Zone>,
    ) { }
    private async exportByFormat(
        data: any[],
        format: string,
        res: Response,
        fileName: string,
    ) {

        // Handle empty data
        if (!data || data.length === 0) {
            const emptyData = [{ message: 'No data to export' }];
            if (format === 'csv') {
                const csv = exportCSV(emptyData, ['message']);
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader(
                    'Content-Disposition',
                    `attachment; filename=${fileName}.csv`,
                );
                return res.send(csv);
            }

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            );
            res.setHeader(
                'Content-Disposition',
                `attachment; filename=${fileName}.xlsx`,
            );

            return exportExcel(
                emptyData,
                [{ header: 'message', key: 'message' }],
                res,
                fileName,
            );
        }

        if (format === 'csv') {
            const csv = exportCSV(data, Object.keys(data[0] || {}));
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename=${fileName}.csv`,
            );
            return res.send(csv);
        }

        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=${fileName}.xlsx`,
        );

        return exportExcel(
            data,
            Object.keys(data[0] || {}).map(k => ({ header: k, key: k })),
            res,
            fileName,
        );
    }

    private async getTicketData(dto: ExportTicketDto) {
        const filter: any = {};

        if (dto.eventId) {
            filter.eventId = new Types.ObjectId(dto.eventId);
        }

        if (dto.status) {
            filter.status = dto.status;
        }

        if (dto.zoneId) {
            filter.zoneId = new Types.ObjectId(dto.zoneId);
        }

        if (dto.startDate || dto.endDate) {
            filter.createdAt = {};
            if (dto.startDate) {
                filter.createdAt.$gte = new Date(dto.startDate);
            }
            if (dto.endDate) {
                filter.createdAt.$lte = new Date(dto.endDate);
            }
        }

        filter.isDeleted = false;

        const tickets = await this.ticketModel
            .find(filter)
            .populate('eventId', 'title')
            .populate('zoneId', 'name')
            .populate('userId', 'email name')
            .lean()
            .exec();

        return tickets.map((ticket: any) => ({
            ticketCode: ticket.ticketCode,
            eventTitle: ticket.eventId?.title || 'N/A',
            zoneName: ticket.zoneId?.name || 'N/A',
            seatNumber: ticket.seatNumber || 'N/A',
            price: ticket.price,
            status: ticket.status,
            userEmail: ticket.userId?.email || 'N/A',
            userName: ticket.userId?.name || 'N/A',
            checkedInAt: ticket.checkedInAt ? new Date(ticket.checkedInAt).toLocaleString() : 'Not checked in',
            checkInLocation: ticket.checkInLocation || 'N/A',
            createdAt: new Date(ticket.createdAt || new Date()).toLocaleString(),
        }));
    }
        private async getCheckInZoneData(dto: ExportCheckInDto) {
        const id = new Types.ObjectId(dto.eventId);
        
        const zones = await this.zoneModel
            .find({ eventId: id })
            .lean()
            .exec();
        const data = await Promise.all(zones.map(async (zone: any) => {
            const checkInCount = await this.ticketModel.countDocuments({
                zoneId: zone._id,
                status: 'used',
                isDeleted: false,
            });
            return {
                zoneName: zone.name,
                totalCheckIns: checkInCount,
                capacity: zone.capacity || 'N/A',   
            };
        }));
        return data;
        }

    async exportCheckInZones(dto: ExportCheckInDto, res: Response) {
        const data = await this.getCheckInZoneData(dto);
        return this.exportByFormat(data, dto.format, res, 'checkin-zones');
    }

    async exportTickets(dto: ExportTicketDto, res: Response) {
        const data = await this.getTicketData(dto);
        return this.exportByFormat(data, dto.format, res, 'tickets');
    }

}
