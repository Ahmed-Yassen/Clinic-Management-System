import { Request, Response, NextFunction } from "express";
import moment from "moment";
import { Op } from "sequelize";
import { Appointments } from "../models/appointments";
import { Doctors } from "../models/doctors";
import { throwCustomError, toGMT2, isOffDay } from "../utils/helperFunctions";
import {
  openingHour,
  closingHour,
  sessionDuration,
  maxSessionsPerDay,
  sessionsPerHour,
} from "../utils/helperVariables";
import { Patients } from "../models/patients";
import { Specialties } from "../models/specialties";

export default class AppointmentsController {
  constructor() {}

  private findDoctorNearestDate(date: Date, doctorAppointments: any) {
    //-First Case: if nearst appointment is at 5 PM
    const firstAppointmentDate = moment(date).hours(openingHour).minutes(0);
    if (
      doctorAppointments.length === 0 ||
      !moment(doctorAppointments[0])
        .subtract(2, "hours")
        .isSame(firstAppointmentDate)
    )
      return firstAppointmentDate.toDate();

    //-Second Case: if neasrt appointment is at 10.40 PM
    const lastAppointmentDate = moment(date)
      .hours(closingHour - 1)
      .minutes(sessionDuration * (sessionsPerHour - 1));
    if (
      doctorAppointments.length === maxSessionsPerDay - 1 &&
      !moment(doctorAppointments[doctorAppointments.length - 1])
        .subtract(2, "hours")
        .isSame(lastAppointmentDate)
    )
      return lastAppointmentDate.toDate();

    //- Third Case: an appointment is free in the middle of the day
    //- Since the array is sorted, we can use binary search
    let startIndex = 0;
    let endIndex = doctorAppointments.length - 1;
    while (startIndex <= endIndex) {
      const middleIndex = Math.floor((startIndex + endIndex) / 2);
      /* Formula to find Correct Time:
      Hours = index + openingHours , then subtract minutes
      Minutes = sessionDuration * index * (sessionsPerHour -1)
      examlpe: correct fifth appointment (index= 4)
      {Hours: 4 + 17 = 21 or 9PM} - {Minutes: 20 * 4 * (3-1) = 160Mins or 2hrs:40Mins }, 
      subtract hours from minutes then fifth appointment is : 9pm - 2hrs:40Mins =  6:20PM
      */
      const correctDate = moment(date)
        .hours(middleIndex + openingHour)
        .subtract(
          sessionDuration * middleIndex * (sessionsPerHour - 1),
          "minutes"
        );

      const currentDate = moment(doctorAppointments[middleIndex]).subtract(
        2,
        "hours"
      );
      if (moment(currentDate).isSame(correctDate)) {
        // Go right
        startIndex = middleIndex + 1;
      } else {
        // Go left
        endIndex = middleIndex - 1;
      }
    }
    const nearstDate = moment(date)
      .hours(openingHour + startIndex)
      .subtract(
        sessionDuration * startIndex * (sessionsPerHour - 1),
        "minutes"
      );

    if (nearstDate.isAfter(lastAppointmentDate)) return null;

    return nearstDate.toDate();
  }

  private findSpecialtyNearestDate = async (
    date: Date,
    specialtyId: number
  ) => {
    const doctors = await Doctors.findAll({
      where: { SpecialtyId: specialtyId },
      attributes: ["id", "fullName"],
    });

    let specialtyNearestAppointment: Date | null = null;
    let nearestAppointmentTemp = moment().add(100, "years").toDate();
    let nearestDoctorId;
    for (let doctor of doctors) {
      //- get each doctors appointment
      const doctorAppointments = (
        await this.getDoctorAppointmentsOnDay(doctor?.id, date)
      ).map((appointment) => appointment.getDataValue("date"));

      //- find each doctors nearest appointment
      let doctorNearestAppointment = this.findDoctorNearestDate(
        date,
        doctorAppointments
      );
      if (!doctorNearestAppointment) continue;
      doctorNearestAppointment = toGMT2(doctorNearestAppointment as Date);
      //- compare nearest appointments and pick nearest one
      if (moment(doctorNearestAppointment).isBefore(nearestAppointmentTemp)) {
        nearestAppointmentTemp = doctorNearestAppointment;
        specialtyNearestAppointment = nearestAppointmentTemp;
        nearestDoctorId = doctor.id;
      }
    }
    return [specialtyNearestAppointment, nearestDoctorId];
  };

  private getDoctorAppointmentsOnDay = async (doctorId: number, date: Date) => {
    const startOfDay = toGMT2(moment(date).hours(openingHour).toDate());
    const endOfDay = toGMT2(moment(date).hours(closingHour).toDate());

    return await Appointments.findAll({
      // attributes: ["date"],
      where: {
        [Op.and]: [
          { date: { [Op.between]: [startOfDay, endOfDay] } },
          { DoctorId: doctorId },
        ],
      },
      order: [["date", "ASC"]],
    });
  };

  private isOldDate(date: Date): Boolean {
    return moment(date).isBefore(moment());
  }

  private validateDate = (date: Date) => {
    this.isOldDate(date) && throwCustomError("This is an old date!", 400);
    isOffDay(date) && throwCustomError("This is an off day!", 400);
  };

  getAllAppointmentsOnDay = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const date = toGMT2(new Date(req.params.date));
      isOffDay(date) && throwCustomError("This is an off day!", 400);

      const startOfDay = toGMT2(moment(date).hours(openingHour).toDate());
      const endOfDay = toGMT2(moment(date).hours(closingHour).toDate());

      const appointments = await Appointments.findAll({
        where: {
          date: { [Op.between]: [startOfDay, endOfDay] },
        },
        order: [["date", "ASC"]],
      });
      res.json(appointments);
    } catch (err) {
      next(err);
    }
  };

  createAppointmentWithSpecificDoctor = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const date = toGMT2(new Date(req.body.date));
      this.validateDate(date);

      const doctor = await Doctors.findByPk(req.params.id);
      !doctor && throwCustomError("Couldnt find a doctor with that id", 404);

      const patient = await Patients.findByPk(req.body.PatientId);
      !patient && throwCustomError("Couldnt find a patient with that id", 404);

      const doctorAppointments = (
        await this.getDoctorAppointmentsOnDay(doctor?.id, date)
      ).map((appointment) => appointment.getDataValue("date"));

      const nearestAppointment = this.findDoctorNearestDate(
        date,
        doctorAppointments
      );
      !nearestAppointment &&
        throwCustomError("This day is full, try another day!", 400);

      const appointment = await Appointments.create({
        date: toGMT2(nearestAppointment as Date),
        SpecialtyId: doctor?.getDataValue("SpecialtyId"),
        DoctorId: doctor?.id,
        PatientId: patient?.id,
      });

      res.status(201).json({ success: true, appointment });
    } catch (error) {
      next(error);
    }
  };

  createAppointmentInSpecialty = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const date = toGMT2(new Date(req.body.date));
      this.validateDate(date);
      const specialty = await Specialties.findByPk(req.params.id);
      !specialty &&
        throwCustomError("Couldnt find a specialty with that id", 404);

      const [specialtyNearestAppointment, nearestDoctorId] =
        await this.findSpecialtyNearestDate(date, specialty?.id);

      !specialtyNearestAppointment &&
        throwCustomError("This day is full!", 400);

      const appointment = await Appointments.create({
        date: specialtyNearestAppointment,
        PatientId: req.body.PatientId,
        SpecialtyId: specialty?.id,
        DoctorId: nearestDoctorId,
      });
      res.status(201).json({ success: true, appointment });
    } catch (error) {
      next(error);
    }
  };

  getDoctorAppointments = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const date = toGMT2(new Date(req.params.date));
      isOffDay(date) && throwCustomError("This is an off day!", 400);

      const doctor = await Doctors.findByPk(req.params.id);
      !doctor && throwCustomError("Couldnt find a doctor with that id", 404);

      const doctorAppointments = await this.getDoctorAppointmentsOnDay(
        doctor?.id,
        date
      );
      if (doctorAppointments.length === 0)
        return res.json({
          msg: `Doctor ${doctor?.fullName} doesnt have appointments on that day!`,
        });

      res.json(doctorAppointments);
    } catch (error) {
      next(error);
    }
  };

  getSpecialtyAppointments = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const date = toGMT2(new Date(req.params.date));
      isOffDay(date) && throwCustomError("This is an off day!", 400);

      const specialty = await Specialties.findByPk(req.params.id);
      !specialty &&
        throwCustomError("Couldnt find a specialty with that id!", 404);

      const startOfDay = toGMT2(moment(date).hours(openingHour).toDate());
      const endOfDay = toGMT2(moment(date).hours(closingHour).toDate());

      const appointments = await Appointments.findAll({
        where: {
          [Op.and]: [
            { date: { [Op.between]: [startOfDay, endOfDay] } },
            { SpecialtyId: specialty?.id },
          ],
        },
        order: [["date", "ASC"]],
      });

      res.json(appointments);
    } catch (error) {
      next(error);
    }
  };

  getDoctorNearestAppointment = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const date = toGMT2(new Date(req.params.date));
      this.validateDate(date);
      const doctor = await Doctors.findByPk(req.params.id);
      !doctor && throwCustomError("Couldnt find a doctor with that id", 404);

      const doctorAppointments = (
        await this.getDoctorAppointmentsOnDay(doctor?.id, date)
      ).map((appointment) => appointment.getDataValue("date"));

      const nearestAppointment = this.findDoctorNearestDate(
        date,
        doctorAppointments
      );
      !nearestAppointment &&
        throwCustomError("This day is full, try another day!", 400);

      res.json({ nearestAppointment: nearestAppointment?.toLocaleString() });
    } catch (error) {
      next(error);
    }
  };

  getSpecialtyNearestAppointment = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const date = toGMT2(new Date(req.params.date));
      this.validateDate(date);

      const specialty = await Specialties.findByPk(req.params.id);
      !specialty &&
        throwCustomError("Couldnt find a specialty with that id", 404);

      const [specialtyNearestAppointment, nearestDoctorId] =
        await this.findSpecialtyNearestDate(date, specialty?.id);

      !specialtyNearestAppointment &&
        throwCustomError("This day is full!", 400);

      res.json({
        nearestDate: specialtyNearestAppointment,
        doctorId: nearestDoctorId,
      });
    } catch (error) {
      next(error);
    }
  };

  editAppointment = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const date = toGMT2(new Date(req.body.date));
      this.validateDate(date);

      let appointment = await Appointments.findByPk(req.params.id);
      !appointment &&
        throwCustomError("Couldnt find an appointment with that id", 404);

      let nearestAppointment: Date | null = null;
      let nearestDoctorId;
      if (req.body.withSameDoctor) {
        nearestDoctorId = appointment?.getDataValue("DoctorId");
        const doctorAppointments = (
          await this.getDoctorAppointmentsOnDay(nearestDoctorId, date)
        ).map((appointment) => appointment.getDataValue("date"));
        nearestAppointment = toGMT2(
          this.findDoctorNearestDate(date, doctorAppointments) as Date
        );
      } else {
        [nearestAppointment, nearestDoctorId] =
          await this.findSpecialtyNearestDate(
            date,
            appointment?.getDataValue("SpecialtyId")
          );
      }
      !nearestAppointment &&
        throwCustomError("This day is full, try another day!", 400);

      appointment = (await appointment?.update({
        date: nearestAppointment,
        DoctorId: nearestDoctorId,
      })) as Appointments;

      res.json(appointment);
    } catch (error) {
      next(error);
    }
  };

  async cancelAppointment(req: Request, res: Response, next: NextFunction) {
    try {
      const appointment = await Appointments.findByPk(req.params.id);
      !appointment &&
        throwCustomError("Couldnt find an appointment with that id", 404);

      await appointment?.destroy();
      res.json({ msg: "Deleted", appointment });
    } catch (error) {
      next(error);
    }
  }
}
